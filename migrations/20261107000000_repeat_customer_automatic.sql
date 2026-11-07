-- Repeat customer is counted by the database, never ticked by hand (Frankie, Nov 7).
-- Rule: a customer is a repeat customer when their orders fall on 2+ different order dates,
-- or when the name carries the shop's trailing "*" marker (used in Notion for buyers with history before these records).
-- Customer = hq.name_key of the name without the "*". Deleted orders don't count and keep their flag as it was.
-- Runs after any insert/delete or change to customer, order date, deletion or the flag itself, so a stale value
-- sent by a form is corrected in the same statement. Only rows whose value changes are written (version untouched).

create or replace function hq.refresh_repeat_customers()
returns void
language sql
set search_path = hq, pg_temp
as $$
  with o as (
    select id, hq.name_key(regexp_replace(customer, '\*+\s*$', '')) as k, customer, order_date
    from hq.orders where deleted_at is null
  ), d as (
    select k, (count(distinct order_date) >= 2 or bool_or(customer ~ '\*\s*$')) as rep
    from o where k is not null group by k
  )
  update hq.orders t
     set repeat_customer = coalesce(d.rep, false)
    from o left join d on d.k = o.k
   where t.id = o.id
     and t.repeat_customer is distinct from coalesce(d.rep, false);
$$;

create or replace function hq.repeat_customers_changed()
returns trigger
language plpgsql
set search_path = hq, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  perform hq.refresh_repeat_customers();
  return null;
end
$$;

drop trigger if exists repeat_follow_orders on hq.orders;
create trigger repeat_follow_orders
  after insert or delete or update of customer, order_date, deleted_at, repeat_customer on hq.orders
  for each statement execute function hq.repeat_customers_changed();

select hq.refresh_repeat_customers();

-- Undo the Nov 7 ship_state column: hq.orders.state already holds the shipping state (its one extra value was copied into state first).
alter table hq.orders drop column if exists ship_state;

-- Backups of the Nov 7 cleanup stay out of the API.
alter table if exists hq_backup_20261107.removed_order_lines enable row level security;
alter table if exists hq_backup_20261107.orders_state_before enable row level security;
alter table hq_backup_20261107.orders_repeat_before enable row level security;
