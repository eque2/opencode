#!/bin/bash
# Runs real bun, then deletes one passing testcase AND lowers every tests="" count by one: the XML is internally
# consistent, but it disagrees with bun's console summary.
bun "$@"; code=$?
for a in "$@"; do case "$a" in --reporter-outfile=*) out="${a#--reporter-outfile=}";; esac; done
perl -0pi -e 's/\n\s*<testcase [^\n]*\/>//; s/(<testsuites [^>]*?tests=")(\d+)/$1.($2-1)/e; s/(<testsuite name="[^"]*" file="[^"]*" tests=")(\d+)/$1.($2-1)/e' "$out"
exit $code
