-- L'index d'unicite des canaux portait sur md5(destination::text) : une
-- expression. PostgREST ne peut pas viser un index d'expression avec
-- "on conflict", d'ou l'echec silencieux de l'ajout de canal.
-- jsonb possede une classe d'operateurs btree : on indexe la colonne
-- directement, ce qui rend l'upsert utilisable.
drop index if exists public.canaux_dedup_idx;
create unique index canaux_dedup_idx on public.canaux (abonne_id, type, destination);;