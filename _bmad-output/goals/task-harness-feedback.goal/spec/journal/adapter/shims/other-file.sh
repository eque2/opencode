#!/bin/bash
# Runs real bun, but on ./other.test.ts in place of the requested file.
args=("$@"); last=$((${#args[@]}-1)); args[$last]="./other.test.ts"
exec bun "${args[@]}"
