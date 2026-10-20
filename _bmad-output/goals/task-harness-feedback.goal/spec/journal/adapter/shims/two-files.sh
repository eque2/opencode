#!/bin/bash
# Runs real bun on the requested file AND ./other.test.ts.
exec bun "$@" ./other.test.ts
