---
name: deploy
description: Use when managing deployments of the FreshBooks MCP Server to AWS EC2.
license: Proprietary
compatibility: "Requires AWS CLI, Terraform, GitHub Actions"
metadata:
  created: "2026-07-13"
  updated: "2026-08-08"
  version: "1.0.0"
---

# FreshBooks MCP Server — Deployment Management

## When to Use

Use this skill when:
- Deploying the FreshBooks MCP Server to AWS EC2
- Triggering a deployment via the `deploy` branch
- Monitoring deployed application health and logs
- Connecting to the EC2 instance via AWS Session Manager
- Updating secrets in AWS Secrets Manager
- Manually deploying without CI
- Tearing down the infrastructure

## Architecture

See `references/architecture.md` for the full architecture diagram and component
details (Route53 → ALB → EC2:3000, TLS termination, session storage, secrets,
logs, access).

## Triggering a Deployment

Push to the `deploy` branch:

```bash
git checkout deploy
git merge main    # or make changes directly
git push origin deploy
```

The GitHub Actions workflow will:
1. Provision/update infrastructure via Terraform
2. Deploy the latest code via SSM Run Command
3. Output a rich job summary with URLs and setup instructions

## Reference Material

- See `references/architecture.md` for the full architecture diagram and component details.
- See `references/operations.md` for operational procedures: monitoring (CloudWatch, health check, PM2), connecting via Session Manager, updating secrets, manual deployment, and teardown.
- See `references/troubleshooting.md` for common issues and resolution steps (app not responding, ALB 502/503, SSE connections dropping, certificate issues).
