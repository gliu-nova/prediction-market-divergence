#!/usr/bin/env python3
"""Entry point for the prediction market divergence service."""

import argparse

import uvicorn

from prediction_market_engine.app import create_app
from prediction_market_engine.config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(description="Prediction market divergence signal engine")
    parser.add_argument("--host", help="Override bind host")
    parser.add_argument("--port", type=int, help="Override bind port")
    parser.add_argument("--poll-once", action="store_true", help="Run one poll cycle and exit")
    args = parser.parse_args()

    config = load_config()
    if args.host:
        config.service.host = args.host
    if args.port:
        config.service.port = args.port

    if args.poll_once:
        import logging

        from prediction_market_engine.engine import PredictionMarketEngine

        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
        engine = PredictionMarketEngine(config)
        count = engine.poll()
        print(f"Poll complete: {count} opportunities found")
        return

    app = create_app(config)
    uvicorn.run(app, host=config.service.host, port=config.service.port)


if __name__ == "__main__":
    main()