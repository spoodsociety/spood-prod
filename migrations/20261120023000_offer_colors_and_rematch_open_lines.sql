-- Data, Nov 19 2026 (Frankie's go-ahead): two open order lines were picked on the order form in a color their piece wasn't listed in,
-- and stayed unmatched. The colors are recorded as offered (the same thing the order form now does on save), then every open
-- unmatched line is matched again. Logged in app_log as rematch / variant_auto; each changed order gets an order_history row.
insert into hq.product_colors (product_id, slot, color_id, source, added_by)
values ('floor-insert-wavy-checkered', 1, 'stardust-purple', 'added', 'claude'),
       ('space-rock-wrap-floor', 1, 'space-grey', 'added', 'claude')
on conflict do nothing;
select hq.rematch_open_lines('claude');
