# FreshBooks MCP Server — Troubleshooting

## App not responding after deploy

1. Check CloudWatch logs for errors
2. SSM into the instance and run `pm2 status` / `pm2 logs`
3. Verify `.env` exists: `cat /srv/freshbooks-mcp/.env`
4. Check if the app port is listening: `ss -tlnp | grep 3000`

## ALB returning 502/503

1. Target group health check may be failing — check ALB target group in AWS Console
2. App may still be bootstrapping — user_data takes ~3-5 minutes on first launch
3. Check `pm2 logs` for startup errors

## SSE connections dropping

The ALB idle timeout is set to 3600s (1 hour). If SSE connections drop sooner, check:
1. Client-side keepalive settings
2. ALB access logs for timeout indicators

## Certificate issues

The ACM certificate is DNS-validated via Route53. If validation fails:
1. Check Route53 for the CNAME validation record
2. Run `terraform apply` again — it will wait for validation
