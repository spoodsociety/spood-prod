-- A new variation's inventory name is built from one of the piece's existing names. It took the oldest one even when that variation had
-- been removed, so a new Space Rock Wrap (for Floor) would have been named after the retired "Space Rock Insert (Floor)". Live ones first.
do $patch$
declare d text; f text;
begin
  foreach f in array array['hq.line_variant(text,text)', 'hq.pick_variant(jsonb,text)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if position('v.inventory_name is not null order by v.archived, v.id limit 1' in d) > 0 then continue; end if;
    if position('v.inventory_name is not null order by v.id limit 1' in d) = 0 then raise exception '%: patch point not found', f; end if;
    execute replace(d, 'v.inventory_name is not null order by v.id limit 1', 'v.inventory_name is not null order by v.archived, v.id limit 1');
  end loop;
end $patch$;
