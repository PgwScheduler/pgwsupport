import React from "react";
import { Clock, Mail, MapPin, Pencil, Phone, UserCheck, UserX } from "lucide-react";
import { Card } from "../ui.jsx";
import { BRAND_LABEL, formatAddress, hoursRows, mailHref, roleLabel, telHref } from "../../lib/directory.js";

// Orange is reserved for things you can act on, so links and the edit
// controls carry it and nothing informational does. "Not assigned" and
// "not entered" are muted, never a warning colour: a gap in the
// directory is not an alarm.
const linkCls = "text-accent-text hover:underline focus:outline-none";
const muted = "text-content-muted";

// Brief flash ring on the card a cross-link just jumped to.
const flashCls = (on) => (on ? " ring-2 ring-content-secondary" : "");

function Badge({ children }) {
  return (
    <span className="rounded border border-hairline-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">
      {children}
    </span>
  );
}

function IconBtn({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-hairline-strong bg-surface-overlay px-2 py-1 text-xs font-medium text-accent-text hover:bg-hairline-strong"
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function InfoRow({ icon: Icon, children }) {
  return (
    <div className="flex gap-2.5 text-sm">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-muted" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PeopleLine({ label, people, onJump }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-content-secondary">{label}</span>
      {people?.length ? (
        people.map((p, i) => (
          <span key={p.id}>
            <button type="button" className={linkCls} onClick={() => onJump(p.id)}>
              {p.display_name}
            </button>
            {i < people.length - 1 && <span className={muted}>,</span>}
          </span>
        ))
      ) : (
        <span className={muted}>Not assigned</span>
      )}
    </div>
  );
}

export function StoreCard({ store: s, managers, dms, onJumpPerson, onEdit, flash }) {
  const address = formatAddress(s);
  const tel = telHref(s.main_phone);
  const hours = hoursRows(s.hours);
  return (
    <Card id={"dir-store-" + s.location_id} tabIndex={-1} className={"flex flex-col gap-3 p-4 outline-none transition-shadow" + flashCls(flash)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="pgw-display text-base font-bold text-content-primary">#{s.store_number ?? "—"}</span>
            <Badge>{BRAND_LABEL[s.brand] ?? s.brand}</Badge>
          </div>
          <p className="text-sm font-medium text-content-primary">{s.name}</p>
          <p className="text-xs text-content-muted">Shop # {s.shop_number ?? "—"}</p>
        </div>
        {onEdit && <IconBtn icon={Pencil} label="Edit" onClick={onEdit} />}
      </div>

      <InfoRow icon={MapPin}>
        {address.length ? (
          address.map((line) => (
            <p key={line} className="text-content-primary">
              {line}
            </p>
          ))
        ) : (
          <p className={muted}>Address not entered</p>
        )}
      </InfoRow>

      <InfoRow icon={Phone}>
        {tel ? (
          <a href={tel} className={linkCls}>
            {s.main_phone}
          </a>
        ) : (
          <p className={muted}>{s.main_phone || "Phone not entered"}</p>
        )}
      </InfoRow>

      <InfoRow icon={Clock}>
        {hours ? (
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
            {hours.map((h) => (
              <React.Fragment key={h.label}>
                <dt className="text-content-secondary">{h.label}</dt>
                <dd className={h.text === "Closed" ? muted : "text-content-primary"}>{h.text}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : (
          <p className={muted}>Hours not entered</p>
        )}
        {s.hours_note && <p className="mt-1 text-xs italic text-content-secondary">{s.hours_note}</p>}
      </InfoRow>

      <div className="mt-auto space-y-1.5 border-t border-hairline pt-3">
        <PeopleLine label="Store manager" people={managers} onJump={onJumpPerson} />
        <PeopleLine label="District manager" people={dms} onJump={onJumpPerson} />
      </div>
    </Card>
  );
}

export function PersonCard({ contact: c, coverage, onJumpStore, onEdit, onToggleActive, flash }) {
  const tel = telHref(c.work_phone);
  const mail = mailHref(c.work_email);
  return (
    <Card id={"dir-person-" + c.id} tabIndex={-1} className={"p-4 outline-none transition-shadow" + flashCls(flash)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="pgw-display text-base font-bold text-content-primary">{c.display_name}</p>
          <p className="text-sm text-content-secondary">{c.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge>{roleLabel(c.role_category)}</Badge>
            {!c.active && <Badge>Deactivated</Badge>}
          </div>
        </div>
        {(onEdit || onToggleActive) && (
          <div className="flex gap-1.5">
            {onEdit && <IconBtn icon={Pencil} label="Edit" onClick={onEdit} />}
            {onToggleActive && (
              <IconBtn icon={c.active ? UserX : UserCheck} label={c.active ? "Deactivate" : "Reactivate"} onClick={onToggleActive} />
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Phone className="h-4 w-4 text-content-muted" />
          {tel ? (
            <a href={tel} className={linkCls}>
              {c.work_phone}
            </a>
          ) : (
            <span className={muted}>{c.work_phone || "No work phone"}</span>
          )}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Mail className="h-4 w-4 flex-shrink-0 text-content-muted" />
          {mail ? (
            <a href={mail} className={linkCls + " break-all"}>
              {c.work_email}
            </a>
          ) : (
            <span className={muted}>No work email</span>
          )}
        </span>
      </div>

      <p className="mt-2 text-sm">
        <span className="mr-1.5 text-xs font-medium uppercase tracking-wide text-content-secondary">Covers</span>
        {coverage.length ? (
          coverage.map((item, i) => (
            <span key={item.key}>
              {item.storeId ? (
                <button type="button" className={linkCls} onClick={() => onJumpStore(item.storeId)}>
                  {item.text}
                </button>
              ) : (
                <span className="text-content-primary">{item.text}</span>
              )}
              {i < coverage.length - 1 && <span className={muted}>; </span>}
            </span>
          ))
        ) : (
          <span className={muted}>Not assigned</span>
        )}
      </p>
    </Card>
  );
}
