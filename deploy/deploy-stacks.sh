#!/usr/bin/env bash
# Deploys the whole platform in order: network -> cluster -> ECR -> images -> services -> pipeline.
# Usage: ./deploy/deploy-stacks.sh <region> [tag]
#
# Optional environment variables:
#   APP_NAME            Resource name prefix (default: saa-microservices)
#   TEST_LISTENER_CIDR  Who may reach the blue/green test listener on :8080
#                       (default: VPC only). Example: "$(curl -s https://checkip.amazonaws.com)/32"
#   SKIP_BUILD=1        Don't build/push images; reuse TAG (which must then be given)
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${1:?Usage: $0 <region> [tag]}"
TAG="${2:-$(date -u +%Y%m%d%H%M%S)}"
APP_NAME="${APP_NAME:-saa-microservices}"
TEST_LISTENER_CIDR="${TEST_LISTENER_CIDR:-10.0.0.0/16}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$APP_NAME"

deploy() {
  local stack="$1" template="$2"; shift 2
  echo "==> Deploying $stack"
  aws cloudformation deploy --region "$REGION" --stack-name "$stack" \
    --template-file "$template" --no-fail-on-empty-changeset "$@"
}

deploy "$APP_NAME-network" infra/01-network.yaml \
  --parameter-overrides AppName="$APP_NAME" TestListenerCidr="$TEST_LISTENER_CIDR"
deploy "$APP_NAME-cluster" infra/02-cluster.yaml --parameter-overrides AppName="$APP_NAME"
deploy "$APP_NAME-ecr" infra/00-ecr.yaml --parameter-overrides AppName="$APP_NAME"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  APP_NAME="$APP_NAME" ./deploy/build-and-push.sh "$ACCOUNT_ID" "$REGION" "$TAG"
fi

# Once the pipeline has deployed Orders, the running image is newer than anything this
# script built. Keep it, so a stack update doesn't roll Orders back.
ORDERS_IMAGE="$REGISTRY/orders:$TAG"
CURRENT_TD="$(aws ecs describe-services --region "$REGION" --cluster "$APP_NAME-cluster" \
  --services "$APP_NAME-orders" --query "services[?status=='ACTIVE'].taskDefinition | [0]" \
  --output text 2>/dev/null || true)"
if [[ -n "$CURRENT_TD" && "$CURRENT_TD" != "None" ]]; then
  ORDERS_IMAGE="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$CURRENT_TD" \
    --query "taskDefinition.containerDefinitions[?name=='app'].image | [0]" --output text)"
  echo "Orders already running $ORDERS_IMAGE - keeping it (the pipeline owns Orders releases)."
fi

deploy "$APP_NAME-services" infra/03-services.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AppName="$APP_NAME" \
    AuthImage="$REGISTRY/auth:$TAG" \
    OrdersImage="$ORDERS_IMAGE" \
    NotificationsImage="$REGISTRY/notifications:$TAG"

deploy "$APP_NAME-pipeline-orders" infra/04-pipeline-orders.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides AppName="$APP_NAME"

echo "Done. ALB DNS name:"
aws cloudformation describe-stacks --region "$REGION" --stack-name "$APP_NAME-cluster" \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text
