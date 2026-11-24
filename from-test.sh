#!/bin/sh
# Brings the app in test/ back to the root (the shop's live address) once it has been clicked through. Then run ./stamp.sh, commit and push.
cd "$(dirname "$0")" && cp test/index.html test/supabase.js test/orders.js test/printplan.js test/inventory.js test/items.js test/collections.js . && ./stamp.sh
