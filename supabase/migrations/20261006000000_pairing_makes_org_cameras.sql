-- Pairing creates an ORG camera, and the org hub is where it is claimed.
--
-- Two device tables have coexisted: `devices`, claimed by QR through /pair and
-- /claim, and `camera_devices`, created from the org hub by an Edge Function
-- that returns an email and a password for someone to type into a phone. The
-- second is where the whole system is going; the FIRST has the better front
-- door, and the constitution names it a rule: "Cameras never have credentials."
--
-- So the QR flow wins and moves onto camera_devices. pair-claim now takes the
-- org node it is claiming into and checks org_camera_can_manage() instead of
-- the legacy owner role; create-camera-device and its password panel are
-- deleted in the same PR.
--
-- redeem_pairing() is untouched on purpose: it only ever read pairing_codes and
-- never joined the device table, so it works unchanged whichever table the
-- claim wrote to.

begin;

-- In-flight claims point at legacy devices and cannot be re-homed: a pairing
-- code is a 10-minute secret, so the honest move is to drop the ones in flight
-- rather than invent a camera_devices row for them. A camera whose claim is
-- cleared here shows its QR again; nobody has to be told anything.
delete from public.pairing_codes;

alter table public.pairing_codes
  drop constraint pairing_codes_device_id_fkey,
  add constraint pairing_codes_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete cascade;

-- The gate moves with the flow. is_human_at_least('owner') is the legacy human
-- ladder; who may pair a camera is the same question as who may manage one,
-- and org_camera_can_manage() is where that already lives. It takes a node, and
-- a pairing_codes row does not carry one -- so this policy asks whether the
-- caller can manage the node the DEVICE was created at, which is the node the
-- claim just placed it in.
drop policy if exists pairing_owner on public.pairing_codes;
create policy pairing_manage on public.pairing_codes for all
  using (
    exists (
      select 1 from public.camera_devices d
       where d.id = pairing_codes.device_id
         and public.org_camera_can_manage(d.org_node_id)
    )
  )
  with check (
    exists (
      select 1 from public.camera_devices d
       where d.id = pairing_codes.device_id
         and public.org_camera_can_manage(d.org_node_id)
    )
  );

commit;
