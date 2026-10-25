#!/usr/bin/env node
import { serveMcp } from '../lib/mcp.js';
import { bridgeAuthorizer } from '../lib/qq-bridge.js';
await serveMcp({ qq: true, authorize: bridgeAuthorizer() });
