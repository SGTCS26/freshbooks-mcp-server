# FreshBooks MCP Server — Architecture

```
Client → Route53 (freshbooks-mcp.bitovi-ai.com)
       → ALB (HTTPS:443, ACM cert, 3600s idle timeout)
       → EC2:3000 (Node.js + PM2, Amazon Linux 2023)
```

- **TLS**: Terminated at the ALB via ACM certificate (DNS-validated through Route53)
- **App**: Runs plain HTTP on port 3000 behind the ALB (`HTTPS=false` in app config)
- **Sessions**: Stored on disk at `~/.freshbooks-mcp/sessions.json`
- **Secrets**: Pulled from AWS Secrets Manager (`freshbooks-mcp-server-env`) at deploy time
- **Logs**: Shipped to CloudWatch via the CloudWatch Agent
- **Access**: AWS SSM Session Manager (no SSH keys needed)
