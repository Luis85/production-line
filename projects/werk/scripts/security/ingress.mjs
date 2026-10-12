import { inputError } from '../runtime/config.mjs';
/** Same-host Caddy profile. Worker transports and enrollment are deliberately unreachable. */
export function ingressProfile({ hostname, port }) {
  if (typeof hostname !== 'string' || hostname.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw inputError('--hostname must be a lowercase DNS hostname without a scheme, path or wildcard.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw inputError('--port must be the existing loopback Factory/orchestrator port (1024–65535).');
  return `${hostname} {
    # Caddy obtains/renews TLS for this hostname. Keep the service bound to loopback.
    @private path /v1/worker/* /v1/workers/register /healthz /status /metrics
    respond @private 404
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }
    request_body {
        max_size 64KB
    }
    # No access log: never retain Authorization headers or request bodies.
    reverse_proxy 127.0.0.1:${port} {
        header_up -X-Forwarded-User
        header_up -X-Auth-Request-User
        transport http {
            response_header_timeout 35s
        }
    }
}
`;
}
