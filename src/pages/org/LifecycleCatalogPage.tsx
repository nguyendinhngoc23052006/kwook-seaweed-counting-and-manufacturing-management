import { type JSX, type ReactNode, useState } from "react";
import { ArchivedDisclosure } from "../../components/org/ArchivedDisclosure";
import { StartPairingQr } from "../../components/org/StartPairingQr";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { ListRow, ListRows } from "../../components/ui/ListRow";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { ListSkeleton } from "../../components/ui/Skeleton";

// Every lifecycle state, drawn with the REAL components.
//
// This is a catalogue, not a mock-up: it imports the same ListRow, Pill,
// ArchivedDisclosure and Empty the actual screens use, so it cannot drift from
// what ships. Change a component and this page changes with it; if a state
// looks wrong here, it is wrong in the app.
//
// It reads nothing and writes nothing -- every row below is a literal on this
// page -- so it renders identically for anyone, with no data and no
// permissions, which is the only way to show states like "eleven cameras
// hidden" without eleven hidden cameras existing.

function StateLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-faint">{children}</div>
  );
}

function Case({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-hairline p-3">
      <StateLabel>{label}</StateLabel>
      {children}
    </div>
  );
}

const LIFECYCLE: { entity: string; retired: string; note: string }[] = [
  { entity: "Unit", retired: "Inactive", note: "Hiding one takes its whole subtree with it" },
  { entity: "Person", retired: "Departed", note: "Employee codes are never reused" },
  { entity: "Seat", retired: "Abolished", note: "The seat's history of holders is kept" },
  { entity: "Rank", retired: "Inactive", note: "Only the sysadmin or CEO may touch the ladder" },
  { entity: "Camera", retired: "Revoked", note: "Hiding also takes it off the floor" },
  { entity: "Station", retired: "Retired", note: "Its counts stay attached to it" },
  { entity: "Line", retired: "Retired", note: "Stations keep pointing at it" },
  { entity: "Job posting", retired: "Closed", note: "Hiding pulls it from the public board" },
  { entity: "Task", retired: "Cancelled", note: "Only whoever set it, or an admin" },
];

export function LifecycleCatalogPage(): JSX.Element {
  const [restored, setRestored] = useState<string[]>([]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">Lifecycle catalogue</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Every state a managed thing can be in, drawn with the same components the real screens
          use. Nothing here reads or writes anything.
        </p>
      </div>

      <Section
        title="The three states"
        description="Retiring is a fact about the factory. Hiding is a fact about the person looking. Only one of them touches the data — neither destroys it."
      >
        <div className="space-y-3 py-2">
          <Case label="active">
            <ListRows>
              <ListRow
                title="Belt 1"
                subtitle="Line A · Counting"
                meta={<Pill tone="success">● live</Pill>}
                trailing={
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost">
                      Edit
                    </Button>
                    <Button size="sm" variant="danger">
                      Retire
                    </Button>
                  </div>
                }
              />
            </ListRows>
          </Case>

          <Case label="retired — still listed, restorable, data intact">
            <ListRows>
              <ListRow
                title="Belt 1"
                subtitle="Line A · Counting"
                meta={<Pill tone="neutral">Retired</Pill>}
                trailing={
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary">
                      Restore
                    </Button>
                    <Button size="sm" variant="ghost">
                      Delete
                    </Button>
                  </div>
                }
              />
            </ListRows>
          </Case>

          <Case label="hidden — gone from every screen; this list is the only place it exists">
            <ArchivedDisclosure
              rows={
                restored.includes("belt-1")
                  ? []
                  : [{ id: "belt-1", title: "Belt 1", subtitle: "Line A · Counting" }]
              }
              onRestore={(id) => setRestored((v) => [...v, id])}
            />
            {restored.includes("belt-1") && (
              <Alert variant="success">
                Brought back. It returns retired, not running — un-hiding never silently puts
                something back to work.
              </Alert>
            )}
          </Case>
        </div>
      </Section>

      <Section
        title="What each thing calls its middle state"
        description="Every entity already had one. None of them had the third until now."
      >
        <div className="py-2">
          <ListRows>
            {LIFECYCLE.map((row) => (
              <ListRow
                key={row.entity}
                title={row.entity}
                subtitle={row.note}
                meta={
                  <div className="flex flex-wrap gap-1">
                    <Pill tone="success">Active</Pill>
                    <Pill tone="neutral">{row.retired}</Pill>
                    <Pill tone="warning">Hidden</Pill>
                  </div>
                }
              />
            ))}
          </ListRows>
        </div>
      </Section>

      <Section
        title="A camera, start to finish"
        description="Scan to start, scan to finish. Neither end needs a keyboard."
      >
        <div className="space-y-3 py-2">
          <Case label="1 — the hub shows where to send the phone">
            <StartPairingQr />
          </Case>
          <Case label="2 — the phone shows its own code back, and waits">
            <div className="flex items-center gap-3">
              <div className="size-24 shrink-0 rounded bg-ink/10" aria-hidden />
              <div className="text-sm text-ink-muted">
                Ask a manager to scan this from Cameras, on the unit this camera stands in. This
                screen switches by itself once they do.
              </div>
            </div>
          </Case>
          <Case label="3 — paired, but nowhere yet">
            <Alert variant="warning">
              This camera has not been given a station yet, so nothing it records can be filed
              anywhere.
            </Alert>
          </Case>
          <Case label="4 — running, with no counter attached">
            <Alert variant="info">
              No counter is attached yet. This camera is running and the wall can see it is alive,
              but nothing is being counted. Minutes are not being filed, so no figure here is a
              measured zero.
            </Alert>
          </Case>
          <Case label="5 — the phone died; the camera outlives it">
            <ListRows>
              <ListRow
                title="Front door"
                subtitle="Check in"
                meta={<Pill tone="danger">● not seen for 3 days</Pill>}
                trailing={
                  <Button size="sm" variant="ghost">
                    Re-pair
                  </Button>
                }
              />
            </ListRows>
          </Case>
          <Case label="6 — unpaired, seen from the phone itself">
            <Empty
              title="This camera has been unpaired"
              description="It has stopped. Everything it already sent is kept. A manager can pair this phone again, or sign out to use it normally."
            />
          </Case>
        </div>
      </Section>

      <Section
        title="The states every list has to have"
        description="Loading, empty, broken, and refused. A screen that only draws the happy path is three bugs waiting."
      >
        <div className="space-y-3 py-2">
          <Case label="loading">
            <ListSkeleton rows={3} />
          </Case>
          <Case label="empty">
            <Empty
              title="No cameras here yet"
              description="Pair one from a phone and it appears in this list."
            />
          </Case>
          <Case label="error">
            <ErrorState
              message="Could not load cameras."
              action={<Button size="sm">Try again</Button>}
            />
          </Case>
          <Case label="refused — the server's own sentence, never replaced">
            <Alert variant="error">You cannot manage cameras at this node.</Alert>
          </Case>
          <Case label="nothing here for this account">
            <Empty
              title="Nothing here for this account"
              description="This account is signed in but is not linked to anyone in the organisation. If this is a phone you meant to turn into a camera, sign out and open /pair on it instead."
            />
          </Case>
        </div>
      </Section>
    </div>
  );
}
