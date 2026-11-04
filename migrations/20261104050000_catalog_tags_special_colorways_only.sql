-- A tag marks a special colorway of a design. A piece pinned to its Standard (only) colorway is not special, so it gets no tag
-- (Neon Halloween lists the Ghost Hide, which comes in one color).
do $do$
declare src text := pg_get_viewdef('hq.catalog'::regclass);
  old text := $x$WHERE ((cp.product_id = v.product_id) AND (cp.color_scheme_id = v.color_scheme_id) AND (NOT cp.enclosure_only))) AS tags$x$;
  new text := $x$WHERE ((cp.product_id = v.product_id) AND (cp.color_scheme_id = v.color_scheme_id) AND (cp.color_scheme_id <> 'standard') AND (NOT cp.enclosure_only))) AS tags$x$;
begin
  if position(old in src) = 0 then raise exception 'catalog view: tags anchor not found'; end if;
  execute 'create or replace view hq.catalog as ' || replace(src, old, new);
end $do$;
