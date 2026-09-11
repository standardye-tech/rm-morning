"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Card, EmptyState, SectionTitle } from "@/components/ui";
import { RADAR, type RadarCategory, type RadarStatus } from "@/lib/config";
import type { RadarContact } from "@/lib/radar-store";

/**
 * Radar recrutement ET / sourcing architectes — V1 volontairement simple.
 *
 * Un pipeline en six statuts, une liste, un formulaire d'ajout. Le statut se
 * change en place. Rien n'est automatique : chaque ligne a été saisie par le
 * directeur régional. Les sources externes viendront plus tard.
 */

const CATEGORY_LABEL = Object.fromEntries(RADAR.categories.map((c) => [c.key, c.label])) as Record<
  RadarCategory,
  string
>;
const STATUS_LABEL = Object.fromEntries(RADAR.statuses.map((s) => [s.key, s.label])) as Record<RadarStatus, string>;

export function RadarToProcess({ contacts }: { contacts: RadarContact[] }) {
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="📋 Candidatures"
        title="Candidatures à traiter"
        aside={
          <Link href="/semaine?vue=radar" className="hover:underline">
            Ouvrir le radar →
          </Link>
        }
      />
      {contacts.length === 0 ? (
        <EmptyState>Aucun contact en attente. Ajoutez des profils dans le radar quand vous en repérez.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 md:px-6">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-ink-faint">{CATEGORY_LABEL[c.category]}</span>
              {c.company ? <span className="text-xs text-ink-soft">{c.company}</span> : null}
              {c.location ? <span className="text-xs text-ink-faint">{c.location}</span> : null}
              <span className="ml-auto text-xs text-ink-soft">{STATUS_LABEL[c.status]}</span>
              {c.nextActionAt ? (
                <span className="tabular text-xs text-ink-faint">
                  {new Date(`${c.nextActionAt}T00:00:00`).toLocaleDateString("fr-FR")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const EMPTY_FORM = {
  category: "et" as RadarCategory,
  name: "",
  company: "",
  location: "",
  url: "",
  phone: "",
  email: "",
  notes: "",
  nextActionAt: "",
};

export function RadarPipeline({ contacts }: { contacts: RadarContact[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [current, setCurrent] = useState(contacts);

  async function post(body: object, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const response = await fetch("/api/semaine/radar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) setError(payload.error ?? "L'opération a échoué.");
      else {
        setCurrent(payload.contacts as RadarContact[]);
        setAdding(false);
        setForm(EMPTY_FORM);
        router.refresh();
      }
    } catch {
      setError("Le serveur n'a pas répondu.");
    } finally {
      setBusy(null);
    }
  }

  const field = (key: keyof typeof EMPTY_FORM, placeholder: string, type = "text") => (
    <input
      type={type}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      placeholder={placeholder}
      aria-label={placeholder}
      className="min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
    />
  );

  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Radar"
        title="Recrutement ET et sourcing architectes"
        aside={`${current.filter((c) => c.status !== "ecarte").length} contact(s) actifs · saisie manuelle`}
      />
      <div className="px-4 py-3 md:px-6 md:py-4">
        {RADAR.statuses.map((status) => {
          const rows = current.filter((c) => c.status === status.key);
          if (rows.length === 0) return null;
          return (
            <div key={status.key} className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint md:text-[11px]">
                {status.label} · {rows.length}
              </p>
              <ul className="mt-1 divide-y divide-line">
                {rows.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="text-xs text-ink-faint">{CATEGORY_LABEL[c.category]}</span>
                    {c.company ? <span className="text-xs text-ink-soft">{c.company}</span> : null}
                    {c.location ? <span className="text-xs text-ink-faint">{c.location}</span> : null}
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="text-xs text-ink-soft underline">
                        profil
                      </a>
                    ) : null}
                    {c.phone ? <span className="text-xs text-ink-soft">{c.phone}</span> : null}
                    {c.email ? <span className="text-xs text-ink-soft">{c.email}</span> : null}
                    {c.notes ? <span className="w-full text-xs text-ink-faint sm:w-auto">{c.notes}</span> : null}
                    <span className="ml-auto flex items-center gap-2">
                      <input
                        type="date"
                        value={c.nextActionAt ?? ""}
                        onChange={(e) =>
                          post({ action: "modifier", id: c.id, patch: { nextActionAt: e.target.value || null } }, `d${c.id}`)
                        }
                        disabled={busy !== null}
                        aria-label="Date de prochaine action"
                        className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs"
                      />
                      <select
                        value={c.status}
                        onChange={(e) => post({ action: "modifier", id: c.id, patch: { status: e.target.value } }, `s${c.id}`)}
                        disabled={busy !== null}
                        aria-label="Statut"
                        className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs"
                      >
                        {RADAR.statuses.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {current.length === 0 ? <p className="text-sm text-ink-faint">Le radar est vide.</p> : null}

        {adding ? (
          <form
            className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              post({ action: "ajouter", contact: { ...form, nextActionAt: form.nextActionAt || null } }, "add");
            }}
          >
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as RadarCategory })}
              aria-label="Catégorie"
              className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
            >
              {RADAR.categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            {field("name", "Nom *")}
            {field("company", "Entreprise")}
            {field("location", "Localisation")}
            {field("url", "URL", "url")}
            {field("phone", "Téléphone", "tel")}
            {field("email", "Email", "email")}
            {field("nextActionAt", "Prochaine action", "date")}
            {field("notes", "Notes")}
            <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
              <button
                type="submit"
                disabled={busy !== null || !form.name.trim()}
                className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50"
              >
                Ajouter
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-canvas"
              >
                Annuler
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-canvas"
          >
            + Ajouter un contact
          </button>
        )}
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}
