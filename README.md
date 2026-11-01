# Spood Production

Static app for the shop floor: Bin View, Print Plan, Inventory, Customers. Served by GitHub Pages at https://spoodsociety.github.io/spood-prod/.

- `index.html` page and boot; `orders.js` Bin View, Order Desk, Customers; `printplan.js`; `inventory.js`; `supabase.js` the only data layer.
- Data: Supabase project `hkllbpipcfzzppbgkzrh`, schema `hq`, reads and writes through RPC only (`read_orders`, `inventory_rows`, `read_app_state`, `save_order`, `complete_order`, `undo_order_done`, `set_line_state`, `apply_moves`, `set_app_state`). Stock is never computed in the browser.
- Sign-in: Supabase Auth (email + password). The database refuses every call without a session, and only emails in `hq.allowed_users` can create an account. The key in `supabase.js` is the publishable key; it is public by design and grants nothing on its own.
- Deploy: run `./stamp.sh` (bumps the module version in the import map so browsers don't keep stale modules), commit, push to `main`; Pages publishes the root.
