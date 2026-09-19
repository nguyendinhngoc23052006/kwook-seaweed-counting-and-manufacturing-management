-- The `middle_manager` rank exists in the staging database and in no file.
--
-- It was created directly when the real company was loaded: the roster has a
-- tier between Trưởng phòng (manager, 5000) and Giám sát/Tổ trưởng
-- (supervisor, 7000) -- the ASMs who run a sales Vùng and the Giám sát sản
-- xuất who runs a production Ca -- and without a rank of its own those ten
-- seats would have had to share a node with the tier above or below them,
-- which is precisely the authority bug that load was rebuilt to fix
-- (org_i_hold resolves by node, so two ranks on one node give the junior one
-- the senior one's powers).
--
-- Creating it outside a migration was the mistake. Schema and the reference
-- data the schema's own logic reads are the migration files' to own: a
-- rebuild from files -- a PR preview branch, a new environment, a restore --
-- produced a database with no such rank, where those ten seats cannot exist
-- and every ASM's reporting line is broken. This is the fix-forward.
--
-- Deliberately NOT changing: org_derive_profile_role() maps ordinals by
-- range, not by key (<= 5000 manager, <= 7000 supervisor, else viewer), so
-- 6000 already resolves to 'supervisor' with no edit. That range test is why
-- 20260920000000 says a new rank is one INSERT and no renumbering -- this
-- migration is that promise being kept.
--
-- Idempotent on the same terms as the original seed, so it is a no-op on the
-- database that already has the row rather than a duplicate-key failure.

begin;

insert into public.ranks (key, name_vi, name_en, ordinal)
select v.key, v.name_vi, v.name_en, v.ordinal
  from (values
    ('middle_manager', 'Quản lý trung gian', 'Middle manager', 6000::numeric)
  ) as v(key, name_vi, name_en, ordinal)
 where not exists (select 1 from public.ranks r where r.key = v.key or r.ordinal = v.ordinal);

commit;
