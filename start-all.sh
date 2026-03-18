#!/bin/sh
pnpm start &    # Start API in background
pnpm run start:worker   # Start worker in foreground