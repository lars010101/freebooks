#!/bin/bash
# Skuld — GCP Setup Script
# Creates BigQuery dataset and deploys Cloud Functions.
# Usage: ./deploy/setup.sh [PROJECT_ID]

set -euo pipefail

PROJECT_ID="${1:-${GCP_PROJECT:-}}"

if [ -z "$PROJECT_ID" ]; then
  echo "Usage: ./deploy/setup.sh <GCP_PROJECT_ID>"
  echo "Or set GCP_PROJECT environment variable."
  exit 1
fi

echo "⚖️  Skuld — Setting up GCP project: $PROJECT_ID"

# Set project
gcloud config set project "$PROJECT_ID"

# Enable required APIs
echo "Enabling APIs..."
gcloud services enable bigquery.googleapis.com
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com

# Create BigQuery dataset
echo "Creating BigQuery dataset..."
bq --project_id="$PROJECT_ID" mk --dataset --location=US finance 2>/dev/null || echo "Dataset 'finance' already exists."

# Apply schema
echo "Creating tables..."
bq query --project_id="$PROJECT_ID" --use_legacy_sql=false < schema/bigquery-ddl.sql

# Deploy Cloud Function
echo "Deploying Cloud Function..."
cd functions
gcloud functions deploy skuld \
  --project="$PROJECT_ID" \
  --runtime=nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=handler \
  --source=. \
  --memory=256MB \
  --timeout=540s \
  --region=us-central1

FUNCTION_URL=$(gcloud functions describe skuld --project="$PROJECT_ID" --region=us-central1 --format='value(httpsTrigger.url)')

echo ""
echo "✅ Skuld deployed successfully!"
echo ""
echo "Cloud Function URL: $FUNCTION_URL"
echo "BigQuery dataset:   $PROJECT_ID.finance"
echo ""
echo "Next steps:"
echo "1. Copy the Google Sheets template"
echo "2. In the Sheet: Menu → Extensions → Apps Script"
echo "3. Set script properties:"
echo "   SKULD_FUNCTION_URL = $FUNCTION_URL"
echo "   GCP_PROJECT_ID     = $PROJECT_ID"
echo "   COMPANY_ID          = (your company ID)"
