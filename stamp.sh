#!/bin/sh
# Stamps the module version in index.html's import map so browsers fetch fresh modules after a deploy. Run before committing.
cd "$(dirname "$0")" && v=$(date +%y%m%d%H%M) && sed -i -E "s/\.js\?v=[0-9a-z]+/.js?v=$v/g" index.html && echo "modules stamped v=$v"
