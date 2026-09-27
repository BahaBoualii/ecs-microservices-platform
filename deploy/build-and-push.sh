#!/usr/bin/env bash
# Builds all three service images and pushes them to their ECR repos (created by infra/00-ecr.yaml).
# Usage: ./deploy/build-and-push.sh <aws-account-id> <region> [tag]
# ECR tags are immutable, so the default tag is a timestamp; pass your own to override.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT_ID="${1:?Usage: $0 <account-id> <region> [tag]}"
REGION="${2:?Usage: $0 <account-id> <region> [tag]}"
TAG="${3:-$(date -u +%Y%m%d%H%M%S)}"
APP_NAME="${APP_NAME:-saa-microservices}"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

for svc in auth orders notifications; do
  REPO_URI="$REGISTRY/$APP_NAME/$svc"
  echo "Building $svc -> $REPO_URI:$TAG"
  # Fargate runs x86_64 by default; pin the platform so Apple Silicon builds still run.
  docker build --platform linux/amd64 -t "$REPO_URI:$TAG" "services/$svc"
  docker push "$REPO_URI:$TAG"
done

echo "All images pushed with tag $TAG:"
for svc in auth orders notifications; do
  echo "  $svc -> $REGISTRY/$APP_NAME/$svc:$TAG"
done
