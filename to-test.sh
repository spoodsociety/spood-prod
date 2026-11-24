#!/bin/sh
# Copies the app as it stands here into test/, the address that reads only the test copy of the database
# (https://prod.spoodsociety.com/test/). A change is made and clicked through in test/ first, then brought back with from-test.sh.
cd "$(dirname "$0")" && mkdir -p test && cp index.html supabase.js orders.js printplan.js inventory.js items.js collections.js test/ && echo "test/ now matches the app"
