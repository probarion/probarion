import Link from "next/link";

export default function DocsNotFound() {
  return (
    <section>
      <h1>This docs page does not exist</h1>
      <p>
        <Link href="/docs">Go to the docs home</Link>
      </p>
    </section>
  );
}
