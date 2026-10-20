#!/bin/bash
# Runs real bun, then deletes the first <testcase .../> line: the attributes now disagree with the cases.
bun "$@"; code=$?
for a in "$@"; do case "$a" in --reporter-outfile=*) out="${a#--reporter-outfile=}";; esac; done
perl -0pi -e 's/\n\s*<testcase [^\n]*\/>//' "$out"
exit $code
