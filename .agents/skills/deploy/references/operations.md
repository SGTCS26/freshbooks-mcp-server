# FreshBooks MCP Server — Operations

## Monitoring

### CloudWatch Logs

```bash
# Tail live logs
aws logs tail /freshbooks-mcp-server/app --follow --region us-east-1 \
  --profile 767397775295_AdministratorAccess

# Search for errors
aws logs filter-log-events \
  --log-group-name /freshbooks-mcp-server/app \
  --filter-pattern "ERROR" \
  --region us-east-1 \
  --profile 767397775295_AdministratorAccess
```

### Health Check

```bash
curl https://freshbooks-mcp.bitovi-ai.com/health
# Expected: {"status":"ok","server":"freshbooks-mcp-server"}
```

### PM2 Status (via SSM)

```bash
# Connect to the instance
INSTANCE_ID=$(cd infra && terraform output -raw instance_id)
aws ssm start-session --target $INSTANCE_ID --region us-east-1

# On the instance:
pm2 status
pm2 logs freshbooks-mcp
```

## Connecting via AWS Session Manager

No SSH keys needed. Requires the AWS CLI and the Session Manager plugin.

```bash
# Install the Session Manager plugin (macOS)
brew install --cask session-manager-plugin

# Connect
INSTANCE_ID=$(cd infra && terraform output -raw instance_id)
aws ssm start-session --target $INSTANCE_ID --region us-east-1 \
  --profile 767397775295_AdministratorAccess
```

## Updating Secrets

Secrets are stored in AWS Secrets Manager as JSON:

```bash
# View current secrets
aws secretsmanager get-secret-value \
  --secret-id freshbooks-mcp-server-env \
  --region us-east-1 \
  --profile 767397775295_AdministratorAccess \
  --query SecretString --output text | jq .

# Update a secret value
aws secretsmanager put-secret-value \
  --secret-id freshbooks-mcp-server-env \
  --region us-east-1 \
  --profile 767397775295_AdministratorAccess \
  --secret-string '{"FRESHBOOKS_CLIENT_ID":"...","FRESHBOOKS_CLIENT_SECRET":"...","MODE":"http","HTTPS":"false","SERVER_URL":"https://freshbooks-mcp.bitovi-ai.com"}'
```

After updating secrets, trigger a redeploy to pull the new values:

```bash
git commit --allow-empty -m "redeploy: refresh secrets"
git push origin deploy
```

## Manual Deployment (without CI)

```bash
cd infra

# Using local AWS profile
export AWS_PROFILE=767397775295_AdministratorAccess
export AWS_DEFAULT_REGION=us-east-1

terraform init
terraform plan
terraform apply

# Deploy app code via SSM
INSTANCE_ID=$(terraform output -raw instance_id)
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["cd /srv/freshbooks-mcp && git pull && npm ci && npm run build && pm2 reload ecosystem.config.cjs"]'
```

## Tearing Down

```bash
cd infra
export AWS_PROFILE=767397775295_AdministratorAccess
export AWS_DEFAULT_REGION=us-east-1

terraform destroy
```

This removes: EC2 instance, ALB, ACM certificate, Route53 record, security groups, IAM role, and CloudWatch log group.

The S3 state bucket (`freshbooks-mcp-server-terraform-state`) and Secrets Manager secret are NOT destroyed — they're managed outside Terraform.
