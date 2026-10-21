from __future__ import annotations

import webbrowser

import uvicorn

from backend.app.config import load_config


def main() -> None:
    config = load_config()
    browser_host = "127.0.0.1" if config.server.listen_ip in {"0.0.0.0", "::"} else config.server.listen_ip
    url = config.server.public_url or f"http://{browser_host}:{config.server.listen_port}"
    if config.server.open_browser_on_start:
        webbrowser.open(url)
    uvicorn.run(
        "backend.app.main:app",
        host=config.server.listen_ip,
        port=config.server.listen_port,
        reload=False,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
