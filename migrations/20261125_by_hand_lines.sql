-- Nov 25, 2026. Frankie: "faux plant is made per order by hand and does not need to be flagged as not in catalog.
-- same with substrate + moss".
--
-- 1. A faux plant line ("Faux plant", "2 faux plants", "1 black plant") is made by hand per order: the resolver
--    answers "untracked" for it, as the team has always marked these lines by hand. Only a line that is nothing
--    but the plant: "Ghost Hide and 2 plants" still asks a person.
-- 2. A piece that is neither printed nor counted (Substrate + Moss, Starter Kit) is made up per order: a size
--    word on its line ("Substrate + Moss (Large)") is not a size the catalog must offer, and is not a
--    disagreement with the pick.
-- 3. Open lines are matched again.
--
-- The two functions are changed in place, so the same file applies to live and to the test copy.
do $mig$
declare d text; n int;
  a1 text := $a$  if cardinality(v_prods) = 0 then
    return jsonb_build_object('status', 'unresolved', 'reason', 'no product', 'head', v_head);$a$;
  b1 text := $b$  if cardinality(v_prods) = 0 then
    -- a faux plant is made by hand per order: never a catalog item, never flagged (Nov 25)
    if v_head_key ~ '^(([0-9]+|one|two|three|four)-)?((faux|fake|artificial|black|white|green)-)*plants?$' then
      return jsonb_build_object('status', 'untracked', 'via', 'by hand');
    end if;
    return jsonb_build_object('status', 'unresolved', 'reason', 'no product', 'head', v_head);$b$;
  a2 text := $a$  if v_size is null and v_badsize is not null and not v_custom then$a$;
  b2 text := $b$  -- a piece that is neither printed nor counted is made up per order: a size word on it is not a catalog size (Nov 25)
  if v_size is null and v_badsize is not null and not v_custom
     and exists (select 1 from hq.products p where p.id = v_prod and (p.printed or p.tracked)) then$b$;
  a3 text := $a$  if said is not null and said <> v.size_code and not (said = 'small' and v.size_code = 'standard') then$a$;
  b3 text := $b$  if said is not null and said <> v.size_code and not (said = 'small' and v.size_code = 'standard')
     and (p.printed or p.tracked) then   -- made up per order: its size word is not checked (Nov 25)$b$;
begin
  d := pg_get_functiondef('hq.resolve_line(text)'::regprocedure);
  if position('by hand' in d) = 0 then
    n := (length(d) - length(replace(d, a1, ''))) / length(a1); if n <> 1 then raise exception 'resolve_line: plant anchor found % times', n; end if;
    d := replace(d, a1, b1);
    n := (length(d) - length(replace(d, a2, ''))) / length(a2); if n <> 1 then raise exception 'resolve_line: size anchor found % times', n; end if;
    d := replace(d, a2, b2);
    execute d;
  end if;
  d := pg_get_functiondef('hq.line_check(text,bigint)'::regprocedure);
  if position('made up per order' in d) = 0 then
    n := (length(d) - length(replace(d, a3, ''))) / length(a3); if n <> 1 then raise exception 'line_check: size anchor found % times', n; end if;
    d := replace(d, a3, b3);
    execute d;
  end if;
  perform hq.rematch_open_lines('by-hand-20261125');
end $mig$;
