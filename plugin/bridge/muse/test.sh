#!/bin/sh
# Runs the Swift unit tests. Command Line Tools ship Swift Testing outside the default search paths.
F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
D=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
cd "$(dirname "$0")" && swift test -Xswiftc -F -Xswiftc $F -Xlinker -F -Xlinker $F -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $D "$@"
