"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { signerFirst } from "@/components/console/KeyActions";
import { CopyButton } from "@/components/docs/CopyButton";
import { busyLabel } from "@/components/pending/busy-label";
import { RouteLink } from "@/components/RouteLink";
import {
  Badge,
  buttonClass,
  Field,
  inputClass,
  lineButtonClass,
  Notice,
  PANEL_TONES,
  type PanelTone,
  type Tone,
  TxLink,
} from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import {
  type AgentEligibility,
  CLONE_PATH_PLACEHOLDER,
  checkPastedPair,
  clientConfigs,
  focusAgent,
  initLines,
  KEY_ERRORS,
  type LedgerBlock,
  type LedgerEligibility,
  type OutsideKey,
  type PairCheck,
  type StatusTone,
  shortKey,
  statusCommand,
  statusRows,
  stepsLeft,
  type VaultKeyFacts,
} from "@/lib/agent/connect";
import type { Network } from "@/lib/config";
import { lockKeyFor } from "@/lib/near/lock";
import type { TxResult } from "@/lib/near/outcome";
import type { WalletTx } from "@/lib/near/tx";
import { formatNear } from "@/lib/near/units";

// The Agent (MCP) tab's client part: the six steps that connect the user's own AI agent to the vault. It holds no
// secret and never could: the user's agent made its keys on its own machine, the form takes only their PUBLIC halves,
// and a pasted secret is refused here, in the browser, so it is never sent. The two wallet buttons ask the server for
// the transaction at click time, and the server checks everything again.

type Prepared = WalletTx | { error: string; status?: 401 | 403 | 409 };

export interface ConnectAgentPanelProps {
  vault: string;
  network: Network;
  /** The signed-in account: the only wallet that may sign here. */
  signer: string;
  /** Owner by role: sees the form. Anyone else sees the status card only. */
  isOwner: boolean;
  /** Owner by role and on chain: the vault would accept the owner's calls. */
  canAct: boolean;
  /** Null when the vault's keys could not be read: no form then. */
  facts: VaultKeyFacts | null;
  outsideAgents: OutsideKey[];
  outsideLedger: OutsideKey | null;
  activeMandateKeys: string[] | null;
  /** The vault's balance of the network's USDC, base units, or null. */
  usdc: string | null;
  /** The vault's NEAR after storage, yocto, or null. */
  freeNear: string | null;
  /** The gas allowances the owner signs, by the vault's tenant kind. */
  allowances: { agentYocto: string; ledgerYocto: string };
  /** Testnet only: the Top-up tab's faucet adds test USDC. */
  testUsdc: boolean;
  /** The MCP server is on npm (MCP_ON_NPM). */
  onNpm: boolean;
  /** Remove, per agent key held outside Probarion, built by the server for the vault. Owner only. */
  removeTxs: Record<string, WalletTx>;
  outOfNearCodes: string[];
  addAgent?: (agentKey: string, label: string) => Promise<Prepared>;
  setLedgerKey?: (ledgerKey: string, replace: string | null) => Promise<Prepared>;
}

const muted = "text-mute";
const eyebrow = "mb-1 block text-xs font-semibold tracking-[.16em] text-gold-ink uppercase";
/** Below 480px a row of links fills the width, one pill per line, as the mockup draws it. */
const pillRow = "max-[480px]:w-full";
/** A wallet button that fills its column on a phone (TxButton's own button, not its small unlock link). */
const wideButtonBelow560 = "max-[560px]:[&>div>button:first-child]:w-full";
/** The same for a wallet button alone in a row of buttons, below 480px. */
const wideButtonBelow480 = "max-[480px]:[&>div>button:first-child]:w-full";
const copyClass =
  "absolute top-2.5 right-2.5 rounded-full border border-paper/25 px-2.5 py-0.5 text-xs font-medium text-paper hover:bg-paper/10";

const TONE_OF: Readonly<Record<StatusTone, Tone>> = {
  good: "good",
  warn: "warn",
  bad: "bad",
  neutral: "neutral",
};

/** A sentence in which each `backticked` part is code. */
function Ticks({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence, never reordered
          <code key={i} className="mono text-[13px] text-ink">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

function StepCard({
  id,
  step,
  title,
  actions,
  children,
}: {
  id: string;
  step: number | null;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="mb-6 min-w-0 rounded-3xl border border-line bg-surface p-5 sm:p-7"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 id={id} className="text-2xl font-light tracking-tight">
          {step !== null ? <span className={eyebrow}>Step {step} of 6</span> : null}
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * An ink code block with a Copy button, as the docs draw one. `copyLabel` is the button's name for a screen reader, as
 * the page has several: "Copy the status command".
 */
function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
  return (
    <div className="relative mt-2">
      <pre className="mono overflow-x-auto rounded-2xl bg-ink px-4 pt-11 pb-4 text-xs text-paper">
        {code}
      </pre>
      <CopyButton text={code} ariaLabel={copyLabel} className={copyClass} />
    </div>
  );
}

type Verdict = "ok" | "not yet";

/**
 * A `status` line as the MCP server prints it: two spaces, the verdict and the check in columns, then the detail. The
 * verdict is coloured as the terminal would show it.
 */
function StatusLine({
  verdict,
  check,
  detail,
}: {
  verdict: Verdict;
  check: string;
  detail: string;
}) {
  return (
    <>
      {"  "}
      <span className={`font-semibold ${verdict === "ok" ? "text-ok" : "text-gold-ink"}`}>
        {verdict}
      </span>
      {`${" ".repeat(9 - verdict.length)}${check.padEnd(11)} ${detail}\n`}
    </>
  );
}

/** What a command prints: a light block, for reading, not copying. */
function Output({ children }: { children: ReactNode }) {
  return (
    <pre className="mono mt-2 overflow-x-auto rounded-2xl border border-line bg-paper px-4 py-3.5 text-xs text-ink">
      {children}
    </pre>
  );
}

/** A result panel. It is not a live region: step 2's status region, mounted with the page, says its title. */
function Panel({ tone, title, children }: { tone: PanelTone; title: string; children: ReactNode }) {
  const t = PANEL_TONES[tone];
  return (
    <section className={`mb-4 rounded-3xl border px-5 py-4 ${t.box}`}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${t.dot}`} />
        <h3 className="text-lg font-normal tracking-tight">{title}</h3>
      </div>
      {children}
    </section>
  );
}

const ONE_LEDGER =
  "A vault has one ledger, so a second one here would fork its history, and the agent would refuse to pay (`LEDGER_FORK_RISK`).";
/** What to do instead, by network: the console creates vaults on testnet only (on mainnet its factory is not deployed). */
const OWN_VAULT: Readonly<Record<Network, string>> = {
  testnet: "Give the agent a vault of its own: it takes one wallet prompt.",
  mainnet:
    "The agent needs a vault of its own. Vaults cannot be created on mainnet yet: its factory is not deployed.",
};

function blockedFirst(reason: LedgerBlock, entries: number): string {
  switch (reason) {
    case "hosted_entries":
      return `Its ledger has ${entries} ${entries === 1 ? "entry" : "entries"}, written by Probarion's hosted Payables.`;
    case "hosted_active":
      return "Probarion's hosted Payables holds its ledger key and writes its ledger.";
    case "hosted_key":
      return "Its ledger key was made by Probarion for hosted Payables.";
    case "anchors":
      return "Its ledger is already anchored on chain, by another ledger key.";
  }
}

function goodText(agent: AgentEligibility, ledger: LedgerEligibility, facts: VaultKeyFacts) {
  const onVault = agent.kind === "on_vault";
  const same = ledger.kind === "same";
  const first =
    onVault && same
      ? "Both keys are already on the vault."
      : onVault
        ? "Both are valid public keys. The agent key is already on the vault; the ledger key is not yet."
        : same
          ? "Both are valid public keys. The ledger key is already the vault's; the agent key is not on the vault yet."
          : "Both are valid public keys and neither is on the vault yet.";
  const second = same
    ? "Its ledger key is this agent's, so nothing else writes its ledger."
    : facts.hostedKeys.length === 0
      ? "The vault has no ledger key, no anchor, and no hosted Payables keys, so nothing else writes its ledger."
      : "The vault has no ledger key, no anchor, and no hosted Payables ledger, so nothing else writes its ledger.";
  return `${first} ${second}`;
}

/** The result of a wallet call made on this page, kept once the button gives way to "on the vault". */
function Done({ network, result }: { network: Network; result: TxResult | undefined }) {
  if (result?.status !== "ok" || result.txHash === null) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <span className={`text-xs ${muted}`}>Confirmed final</span>
      <TxLink network={network} hash={result.txHash} />
    </div>
  );
}

/** Reads the page again from the chain. It stays focusable while it reads (aria-disabled), and a press then does nothing. */
function RecheckButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className={lineButtonClass}
      aria-disabled={pending || undefined}
      onClick={() => {
        if (!pending) start(() => router.refresh());
      }}
    >
      {busyLabel("Check on chain again", "Checking the chain…", pending)}
    </button>
  );
}

const TAB_BUTTON =
  "min-h-11 shrink-0 rounded-full border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-gold-small";

function ClientTabs({
  vault,
  network,
  onNpm,
}: {
  vault: string;
  network: Network;
  onNpm: boolean;
}) {
  const configs = clientConfigs(vault, network, onNpm);
  const [picked, setPicked] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const uid = useId();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (i + step + configs.length) % configs.length;
    setPicked(next);
    refs.current[next]?.focus();
  };
  return (
    <>
      <div
        role="tablist"
        aria-label="MCP client"
        className="mt-1 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {configs.map((c, i) => (
          <button
            key={c.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${c.id}`}
            aria-controls={`${uid}-panel-${c.id}`}
            aria-selected={i === picked}
            tabIndex={i === picked ? 0 : -1}
            onClick={() => setPicked(i)}
            onKeyDown={(e) => onKey(e, i)}
            className={
              i === picked
                ? `${TAB_BUTTON} border-ink bg-ink text-paper`
                : `${TAB_BUTTON} border-ink/15 bg-surface text-ink`
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      {configs.map((c, i) => (
        <div
          key={c.id}
          role="tabpanel"
          id={`${uid}-panel-${c.id}`}
          aria-labelledby={`${uid}-tab-${c.id}`}
          hidden={i !== picked}
        >
          {c.where ? (
            <p className={`mt-3 text-sm ${muted}`}>
              <Ticks text={c.where} />
            </p>
          ) : null}
          <CodeBlock
            code={c.code}
            copyLabel={
              c.where === null ? `Copy the ${c.label} command` : `Copy the ${c.label} settings`
            }
          />
          {c.windows ? (
            <p className={`mt-3 text-sm ${muted}`}>
              <Ticks text={c.windows} />
            </p>
          ) : null}
          {c.windowsCode ? (
            <CodeBlock code={c.windowsCode} copyLabel={`Copy the ${c.label} Windows command`} />
          ) : null}
        </div>
      ))}
    </>
  );
}

const STEPS_LEFT = [
  "",
  "One step left.",
  "Two steps left.",
  "Three steps left.",
  "Four steps left.",
];

function StatusCard(
  props: ConnectAgentPanelProps & {
    facts: VaultKeyFacts;
    pasted: { agentKey: string; ledgerKey: string } | null;
    step: number | null;
  },
) {
  const rows = statusRows({
    vault: props.vault,
    testnet: props.testUsdc,
    facts: props.facts,
    outsideAgents: props.outsideAgents,
    outsideLedger: props.outsideLedger,
    activeMandateKeys: props.activeMandateKeys,
    usdc: props.usdc,
    pasted: props.pasted,
  });
  const left = stepsLeft(rows);
  const status = statusCommand(props.vault, props.network, props.onNpm);
  const keysDir = `~/.probarion/${props.vault}`;
  const focus = focusAgent({ outsideAgents: props.outsideAgents, pasted: props.pasted });
  const remove = focus !== null && props.canAct ? props.removeTxs[focus] : undefined;
  return (
    <StepCard id="agent-check" step={props.step} title="Check it" actions={<RecheckButton />}>
      <dl>
        {rows.map((r) => (
          <div
            key={r.id}
            className="grid min-w-0 gap-x-4 gap-y-1 border-t border-line py-3 first:border-t-0 first:pt-0 sm:grid-cols-[240px_minmax(0,1fr)_auto] sm:items-center"
          >
            <dt className="text-sm font-medium">{r.title}</dt>
            <dd className={`min-w-0 text-sm wrap-anywhere ${muted}`}>
              <Ticks text={r.text} />
            </dd>
            <dd className="justify-self-start sm:justify-self-end">
              <Badge tone={TONE_OF[r.tone]}>{r.badge}</Badge>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t border-line pt-4 text-sm">
        {left === 0 ? "Ready on chain." : (STEPS_LEFT[left] ?? `${left} steps left.`)} On the
        agent&apos;s machine, <code className="mono text-[13px]">status</code> runs the same checks
        plus the local ledger:
      </p>
      <CodeBlock code={status.posix} copyLabel="Copy the status command" />
      <p className={`mt-2 text-xs ${muted}`}>
        In Windows PowerShell, set the vault first:{" "}
        <code className="mono wrap-anywhere">{status.powershell}</code>
      </p>
      <p className={`mt-3 text-xs font-semibold tracking-[.08em] uppercase ${muted}`}>
        What it prints, roughly
      </p>
      <Output>
        {`probarion-mcp status: vault ${props.vault} on ${props.network}. Read-only: nothing is signed or sent.\n`}
        <StatusLine verdict="ok" check="keys" detail={`from the keys file ${keysDir}/keys.json`} />
        <StatusLine verdict="ok" check="vault" detail="not frozen" />
        <StatusLine
          verdict="ok"
          check="agent key"
          detail="ed25519:... is an agent key of the vault: for spend only, 1 NEAR of allowance left"
        />
        <StatusLine verdict="not yet" check="ledger key" detail="the vault has no ledger key yet" />
        <StatusLine
          verdict="not yet"
          check="mandates"
          detail="no active mandate is bound to the agent key"
        />
        <StatusLine verdict="ok" check="USDC" detail="25 USDC in the vault" />
        <StatusLine
          verdict="ok"
          check="ledger"
          detail={`${keysDir}/ledger.jsonl holds 0 entries, and the vault has no anchor yet`}
        />
        {"\nNot ready: 2 not yet.\nNext (ledger key): ..."}
      </Output>
      <p className="mt-4 text-sm">
        When every line says ok, ask your agent:{" "}
        <i>
          &quot;List my Probarion mandates, then pay invoice INV-1 for 0.01 USDC under mandate
          1.&quot;
        </i>{" "}
        A payment above the mandate&apos;s approval threshold waits for you on the Approve page.
      </p>
      {remove ? (
        <>
          <div className={wideButtonBelow480}>
            <TxButton
              label="Remove this agent key"
              network={props.network}
              expectedSigner={props.signer}
              tx={remove}
              lockKey={lockKeyFor(`agent:remove:${props.vault}:${focus}`)}
              confirm="Remove this agent key from the vault? The agent that holds it stops at once."
              confirmTone="danger"
              describe={signerFirst(props.outOfNearCodes)}
            />
          </div>
          <p className={`text-xs ${muted}`}>
            Removing the agent key stops the agent at once. Its ledger stays valid; anchors already
            on chain keep the key that signed them.
          </p>
        </>
      ) : null}
    </StepCard>
  );
}

/** Owner only (the page renders the form for the owner; the actions check again). */
export function ConnectAgentPanel(props: ConnectAgentPanelProps) {
  const [agentRaw, setAgentRaw] = useState("");
  const [ledgerRaw, setLedgerRaw] = useState("");
  const [label, setLabel] = useState("mcp-claude");
  /** The form as "Check these keys" saw it; cleared by any edit, so no stale key reaches a button. */
  const [submitted, setSubmitted] = useState<{
    agent: string;
    ledger: string;
    label: string;
  } | null>(null);
  const [results, setResults] = useState<{ agent?: TxResult; ledger?: TxResult }>({});
  const facts = props.facts;
  // Checked against the facts of the page as it is now: after a wallet call and a refresh, a key on the vault is done.
  const check = useMemo(
    () => (facts !== null && submitted !== null ? checkPastedPair(facts, submitted) : null),
    [facts, submitted],
  );
  const ok = check?.ok ? check : null;
  const agentInput = useRef<HTMLInputElement>(null);
  const ledgerInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  /** The field a failed check sends the focus to, once its error is on the page (`at` tells two checks apart). */
  const [focusTo, setFocusTo] = useState<{ field: FieldName; at: number } | null>(null);
  useEffect(() => {
    if (focusTo === null) return;
    const to = { agent: agentInput, ledger: ledgerInput, label: labelInput }[focusTo.field];
    to.current?.focus();
  }, [focusTo]);

  if (facts === null) return null;
  if (!props.isOwner) {
    return (
      <>
        <p className={`mb-4 text-sm ${muted}`}>
          Only the vault&apos;s owner can connect an agent. This is what the chain shows now.
        </p>
        <StatusCard {...props} facts={facts} pasted={null} step={null} />
      </>
    );
  }

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setSubmitted(null);
  };
  const onCheck = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = { agent: agentRaw, ledger: ledgerRaw, label };
    setSubmitted(form);
    const field = firstErrorField(checkPastedPair(facts, form));
    if (field !== null) setFocusTo({ field, at: Date.now() });
  };
  const init = initLines(props.vault, props.network, props.onNpm);
  const keysDir = `~/.probarion/${props.vault}`;
  const agentNear = formatNear(props.allowances.agentYocto, 3);
  const ledgerNear = formatNear(props.allowances.ledgerYocto, 3);
  const describe = signerFirst(props.outOfNearCodes);
  const focus = focusAgent({
    outsideAgents: props.outsideAgents,
    pasted: ok ? { agentKey: ok.agentKey, ledgerKey: ok.ledgerKey } : null,
  });
  const focusLabel =
    ok?.agent.kind === "on_vault"
      ? ok.agent.label
      : (props.outsideAgents.find((a) => a.public_key === focus)?.label ?? null);
  // Before anything is pasted, step 3 says what the chain shows, as step 6 does: the vault's one agent key held
  // outside Probarion, and its ledger key when the user's own agent holds it, scoped to anchor().
  const chainAgent = ok === null ? focus : null;
  const chainLedger =
    ok === null && props.outsideLedger?.access.state === "scoped"
      ? props.outsideLedger.public_key
      : null;
  const agentLine = ok
    ? shortKey(ok.agentKey)
    : chainAgent !== null
      ? shortKey(chainAgent)
      : "the agent key from step 2";
  const ledgerLine = ok
    ? shortKey(ok.ledgerKey)
    : chainLedger !== null
      ? shortKey(chainLedger)
      : "the ledger key from step 2";
  const agentLabelLine = ok
    ? ok.agent.kind === "on_vault"
      ? ok.agent.label
      : ok.label
    : chainAgent !== null
      ? (focusLabel ?? "")
      : label;
  const agentOnVault = ok ? ok.agent.kind === "on_vault" : chainAgent !== null;
  const ledgerOnVault = ok ? ok.ledger.kind === "same" : chainLedger !== null;
  const bound =
    focus === null || props.activeMandateKeys === null
      ? null
      : props.activeMandateKeys.filter((k) => k === focus).length;
  const base = `/console/${encodeURIComponent(props.vault)}`;

  return (
    <>
      <StepCard id="agent-keys" step={1} title="Make the keys on your machine">
        <p className="text-sm">
          Run this in a terminal on the computer where your agent runs.{" "}
          {props.onNpm
            ? "It needs Node 24 or later."
            : "It builds the MCP server from a clone of the public repository, and needs git, Node 24 or later and pnpm 10."}{" "}
          It saves both keys to a keys file and prints only their public halves. On macOS and Linux
          only you can read that file (mode 0600). On Windows its folder&apos;s permissions apply,
          so keep that folder private.
        </p>
        <CodeBlock code={init.lines.join("\n")} copyLabel="Copy the commands that make the keys" />
        <p className={`mt-2 text-xs ${muted}`}>
          {init.powershell !== null ? (
            <>
              In Windows PowerShell, the last line is{" "}
              <code className="mono wrap-anywhere">{init.powershell}</code>.{" "}
            </>
          ) : init.lines.length === 1 ? (
            "On Windows the same line works in PowerShell. "
          ) : (
            "On Windows the same lines work in PowerShell. "
          )}
          {init.lines.length === 1
            ? "Run it again any time: it never overwrites the keys, it prints the public keys again."
            : "Run the last line again any time: it never overwrites the keys, it prints the public keys again."}
        </p>
        <p className={`mt-4 text-xs font-semibold tracking-[.08em] uppercase ${muted}`}>
          What it prints, roughly
        </p>
        <Output>
          {`probarion-mcp init: vault ${props.vault} on ${props.network}\nWrote the keys file ${keysDir}/keys.json (mode 0600). It holds the two secret keys, which are not printed.\n\nagent public key:  `}
          <span className="font-semibold text-gold-ink">ed25519:...</span>
          {"\nledger public key: "}
          <span className="font-semibold text-gold-ink">ed25519:...</span>
          {"\n\nNext: ..."}
        </Output>
        <p className={`mt-2 text-xs ${muted}`}>
          Back up the folder <code className="mono wrap-anywhere">{keysDir}/</code>, and keep the
          backup as private as the keys file: its <code className="mono">ledger.jsonl</code> is the
          only copy of this agent&apos;s signed record.
        </p>
      </StepCard>

      <StepCard id="agent-paste" step={2} title="Paste the two public keys">
        {/* A form, so Enter in a field runs the check. Nothing is submitted: the check runs here, in the browser. */}
        <form onSubmit={onCheck} noValidate>
          <div className="grid gap-x-6 md:grid-cols-2">
            <Field
              label="Agent public key"
              hint={
                ok?.agent.kind === "on_vault"
                  ? KEY_ERRORS.onVault
                  : "It can call spend() only. A vault holds at most 16 agent keys."
              }
              error={check && !check.ok ? (check.agentError ?? undefined) : undefined}
            >
              <input
                ref={agentInput}
                className={`${inputClass} mono`}
                value={agentRaw}
                onChange={edit(setAgentRaw)}
                autoComplete="off"
                spellCheck={false}
                placeholder="ed25519:..."
              />
            </Field>
            <Field
              label="Ledger public key"
              hint="It can call anchor() only, and signs each ledger entry."
              error={check && !check.ok ? (check.ledgerError ?? undefined) : undefined}
            >
              <input
                ref={ledgerInput}
                className={`${inputClass} mono`}
                value={ledgerRaw}
                onChange={edit(setLedgerRaw)}
                autoComplete="off"
                spellCheck={false}
                placeholder="ed25519:..."
              />
            </Field>
          </div>
          <div className="max-w-[420px]">
            <Field
              label="Agent key label"
              hint="At most 64 bytes. It is stored on the vault with the key, where anyone can read it."
              error={check && !check.ok ? (check.labelError ?? undefined) : undefined}
            >
              {/* No maxLength: a long paste reaches the check whole, so a key pasted here is caught, not cut. */}
              <input
                ref={labelInput}
                className={inputClass}
                value={label}
                onChange={edit(setLabel)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button type="submit" className={`${buttonClass} ${pillRow}`}>
              Check these keys
            </button>
          </div>
        </form>
        {/* Mounted with the page, so the result of each check is announced. */}
        <p role="status" className="sr-only">
          {checkStatus(check)}
        </p>
        {ok ? (
          <CheckedPanel
            ok={ok}
            facts={facts}
            network={props.network}
            replaceButton={
              ok.ledger.kind === "replace" && props.canAct && props.setLedgerKey ? (
                <TxButton
                  label="Replace the ledger key in my wallet"
                  network={props.network}
                  expectedSigner={props.signer}
                  lockKey={lockKeyFor(`agent:set-ledger:${props.vault}:${ok.ledgerKey}`)}
                  prepare={() =>
                    props.setLedgerKey?.(ok.ledgerKey, replaced(ok.ledger)) ?? noAction()
                  }
                  confirm={REPLACE_CONFIRM}
                  confirmTone="danger"
                  describe={describe}
                  onResult={(r) => setResults((s) => ({ ...s, ledger: r }))}
                />
              ) : null
            }
          />
        ) : null}
      </StepCard>

      <StepCard id="agent-sign" step={3} title="Sign two calls in your wallet">
        <ul>
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-line pt-1 pb-4">
            <div className="min-w-0 flex-[1_1_320px]">
              <h3 className="flex flex-wrap items-center gap-2 text-base font-medium">
                Add the agent key{" "}
                {agentOnVault ? (
                  <Badge tone="good">on the vault</Badge>
                ) : (
                  <Badge tone="warn">not yet</Badge>
                )}
              </h3>
              <p className={`mt-0.5 text-sm wrap-anywhere ${muted}`}>
                <code className="mono text-[13px]">add_agent</code> on {props.vault}: key{" "}
                {agentLine}, label &quot;{agentLabelLine}&quot;,{" "}
                <code className="mono text-[13px]">spend()</code> only, {agentNear} NEAR gas
                allowance, 1 yoctoNEAR deposit.
              </p>
            </div>
            <div
              className={`flex flex-none flex-col items-end gap-1 max-[560px]:w-full max-[560px]:items-stretch ${wideButtonBelow560}`}
            >
              {ok === null ? (
                chainAgent !== null ? (
                  <Done network={props.network} result={results.agent} />
                ) : (
                  <span className={`text-xs ${muted}`}>Check the keys in step 2 first.</span>
                )
              ) : ok.agent.kind === "on_vault" ? (
                <Done network={props.network} result={results.agent} />
              ) : props.canAct && props.addAgent ? (
                <TxButton
                  label="Add agent key in my wallet"
                  network={props.network}
                  expectedSigner={props.signer}
                  lockKey={lockKeyFor(`agent:add:${props.vault}:${ok.agentKey}`)}
                  prepare={() => props.addAgent?.(ok.agentKey, ok.label) ?? noAction()}
                  describe={describe}
                  onResult={(r) => setResults((s) => ({ ...s, agent: r }))}
                />
              ) : (
                <NotSigner />
              )}
            </div>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-line py-4">
            <div className="min-w-0 flex-[1_1_320px]">
              <h3 className="flex flex-wrap items-center gap-2 text-base font-medium">
                Set the ledger key{" "}
                {ledgerOnVault ? (
                  <Badge tone="good">on the vault</Badge>
                ) : ok?.ledger.kind === "blocked" ? (
                  <Badge tone="neutral">not offered</Badge>
                ) : (
                  <Badge tone="warn">not yet</Badge>
                )}
              </h3>
              <p className={`mt-0.5 text-sm wrap-anywhere ${muted}`}>
                <code className="mono text-[13px]">set_ledger_key</code>: key {ledgerLine},{" "}
                <code className="mono text-[13px]">anchor()</code> only, {ledgerNear} NEAR gas
                allowance, 1 yoctoNEAR deposit.
              </p>
            </div>
            <div
              className={`flex flex-none flex-col items-end gap-1 max-[560px]:w-full max-[560px]:items-stretch ${wideButtonBelow560}`}
            >
              {ok === null ? (
                chainLedger !== null ? (
                  <Done network={props.network} result={results.ledger} />
                ) : (
                  <span className={`text-xs ${muted}`}>Check the keys in step 2 first.</span>
                )
              ) : ok.ledger.kind === "same" ? (
                <Done network={props.network} result={results.ledger} />
              ) : ok.ledger.kind === "blocked" ? (
                <span className={`text-xs ${muted}`}>
                  Not offered: this vault keeps its ledger elsewhere (step 2).
                </span>
              ) : ok.ledger.kind === "replace" ? (
                <span className={`text-xs ${muted}`}>
                  Replace the vault&apos;s unused ledger key in step 2 first.
                </span>
              ) : props.canAct && props.setLedgerKey ? (
                <TxButton
                  label="Set ledger key in my wallet"
                  network={props.network}
                  expectedSigner={props.signer}
                  lockKey={lockKeyFor(`agent:set-ledger:${props.vault}:${ok.ledgerKey}`)}
                  prepare={() => props.setLedgerKey?.(ok.ledgerKey, null) ?? noAction()}
                  describe={describe}
                  onResult={(r) => setResults((s) => ({ ...s, ledger: r }))}
                />
              ) : (
                <NotSigner />
              )}
            </div>
          </li>
        </ul>
        <p className={`mt-1 text-xs ${muted}`}>
          Each key is stored on the vault, which needs a little free NEAR:{" "}
          {props.freeNear === null
            ? "this vault's free NEAR could not be read."
            : `this vault has ${formatNear(props.freeNear, 2)} NEAR free.`}{" "}
          Two prompts, not one batched transaction, so each result is read back on its own.
        </p>
      </StepCard>

      <StepCard id="agent-mandate" step={4} title="Give it a mandate">
        <p className="text-sm">
          The agent can pay only the payee of a mandate you sign for its key, up to its caps.{" "}
          {focusLabel !== null
            ? `The mandate form already lists this key as "${focusLabel}".`
            : `Once the key is on the vault, the mandate form lists it as "${ok?.label ?? label}".`}
        </p>
        <div className="mt-3">
          {bound !== null && bound > 0 ? (
            <Notice tone="good">
              {bound === 1
                ? "1 active mandate is bound to this key."
                : `${bound} active mandates are bound to this key.`}
            </Notice>
          ) : props.activeMandateKeys === null ? (
            <Notice tone="warn">The mandates could not be read: reload to check them.</Notice>
          ) : (
            <Notice tone="warn">
              No mandate is bound to this key yet, so the agent cannot pay anyone.
            </Notice>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <RouteLink
            route="/console/[vault]/mandates"
            href={`${base}/mandates`}
            className={`${buttonClass} ${pillRow}`}
          >
            Create a mandate for this key
          </RouteLink>
          {props.testUsdc ? (
            <RouteLink
              route="/console/[vault]/topup"
              href={`${base}/topup`}
              className={`${lineButtonClass} ${pillRow}`}
            >
              Add test USDC
            </RouteLink>
          ) : null}
        </div>
      </StepCard>

      <StepCard id="agent-client" step={5} title="Add it to your MCP client">
        <p className="text-sm">
          No secret goes into these settings: the server reads both keys from the keys file on its
          own machine. The only setting is the vault.
        </p>
        {!props.onNpm ? (
          <p className={`mt-2 text-sm ${muted}`}>
            Use the full path of your clone in place of{" "}
            <code className="mono text-[13px] text-ink">{CLONE_PATH_PLACEHOLDER}</code>.
          </p>
        ) : null}
        <ClientTabs vault={props.vault} network={props.network} onNpm={props.onNpm} />
        <p className={`mt-3 text-xs ${muted}`}>
          Keys kept elsewhere? Add <code className="mono">PROBARION_KEYS_FILE</code> with the
          file&apos;s full path. <code className="mono">PROBARION_AGENT_KEY</code> and{" "}
          <code className="mono">PROBARION_LEDGER_KEY</code> still work, but they put the secrets in
          this settings file.
        </p>
      </StepCard>

      <StatusCard
        {...props}
        facts={facts}
        pasted={ok ? { agentKey: ok.agentKey, ledgerKey: ok.ledgerKey } : null}
        step={6}
      />
    </>
  );
}

/** In place of a wallet button the vault would refuse: the page says above whose call it accepts. */
function NotSigner() {
  return (
    <span className={`text-xs ${muted}`}>Only the vault&apos;s owner on chain can sign this.</span>
  );
}

export const REPLACE_CONFIRM =
  "Replace the vault's ledger key? The current one is removed from the vault. Nothing was anchored with it.";

function replaced(l: LedgerEligibility): string | null {
  return l.kind === "replace" ? l.current : null;
}

async function noAction(): Promise<Prepared> {
  return { error: "Only the vault's owner can sign this." };
}

type FieldName = "agent" | "ledger" | "label";
type Checked = PairCheck & { ok: true };

/** The first field, in the page's order, whose check failed; null when the check passed. */
export function firstErrorField(check: PairCheck): FieldName | null {
  if (check.ok) return null;
  if (check.agentError !== null) return "agent";
  if (check.ledgerError !== null) return "ledger";
  if (check.labelError !== null) return "label";
  return null;
}

const CHECKED_TITLE = {
  blocked: "This vault already keeps its ledger elsewhere",
  replace: "The vault has another ledger key, never used",
  good: "This agent can own this vault's ledger",
} as const;

function checkedTitle(ok: Checked): string {
  return ok.ledger.kind === "blocked"
    ? CHECKED_TITLE.blocked
    : ok.ledger.kind === "replace"
      ? CHECKED_TITLE.replace
      : CHECKED_TITLE.good;
}

/**
 * What step 2's status region says after "Check these keys": the result panel's title, or the first field's error.
 * Both are fixed sentences, so nothing that was pasted is ever read out.
 */
export function checkStatus(check: PairCheck | null): string {
  if (check === null) return "";
  if (check.ok) return checkedTitle(check);
  return check.agentError ?? check.ledgerError ?? check.labelError ?? "";
}

/** The result of a check that passed, under step 2. Exported for its tests. */
export function CheckedPanel({
  ok,
  facts,
  network,
  replaceButton,
}: {
  ok: Checked;
  facts: VaultKeyFacts;
  network: Network;
  replaceButton: ReactNode;
}) {
  if (ok.ledger.kind === "blocked") {
    return (
      <Panel tone="warn" title={CHECKED_TITLE.blocked}>
        <p className="mt-1.5 text-sm">
          <Ticks
            text={`${blockedFirst(ok.ledger.reason, facts.hostedLedgerEntries)} ${ONE_LEDGER} ${OWN_VAULT[network]}`}
          />
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {network === "testnet" ? (
            <RouteLink route="/console" className={`${buttonClass} ${pillRow}`}>
              Create a vault for this agent
            </RouteLink>
          ) : null}
          <RouteLink
            route="/docs/build/let-an-agent-pay"
            href="/docs/build/let-an-agent-pay#one-ledger-writer-per-vault"
            className={`${lineButtonClass} ${pillRow}`}
          >
            Why one ledger per vault
          </RouteLink>
        </div>
      </Panel>
    );
  }
  if (ok.ledger.kind === "replace") {
    return (
      <Panel tone="warn" title={CHECKED_TITLE.replace}>
        <p className="mt-1.5 text-sm wrap-anywhere">
          The vault&apos;s ledger key is {shortKey(ok.ledger.current)}, and nothing was ever
          anchored with it. Setting this agent&apos;s key replaces it: whoever holds the old key can
          no longer anchor.
        </p>
        {replaceButton ? <div className={`mt-3 ${wideButtonBelow480}`}>{replaceButton}</div> : null}
      </Panel>
    );
  }
  return (
    <Panel tone="good" title={CHECKED_TITLE.good}>
      <p className="mt-1.5 text-sm">{goodText(ok.agent, ok.ledger, facts)}</p>
      <dl className="mt-2.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
        <dt className="opacity-80">Agent</dt>
        <dd className="mono wrap-anywhere">{shortKey(ok.agentKey)}</dd>
        <dt className="opacity-80">Ledger</dt>
        <dd className="mono wrap-anywhere">{shortKey(ok.ledgerKey)}</dd>
      </dl>
      <p className="mt-1.5 text-xs opacity-85">
        Match both with what your terminal printed. Paste only keys you made yourself: whoever holds
        a key you add can pay under any mandate you bind to it.
      </p>
    </Panel>
  );
}
