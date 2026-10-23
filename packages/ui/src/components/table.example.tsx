/**
 * Table — §7.9 example gallery (documentation-as-code).
 *
 * Uppercase muted headers, 1px dividers, right-aligned numeric columns with
 * tabular numerals, the signal left-edge on the selected row, sticky header
 * and the in-body empty state. Typecheck-only docs — never run by vitest.
 */
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "./table";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function TableExample() {
  return (
    <section
      aria-label="Table examples"
      className="flex max-w-3xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Render history — sticky header, numeric columns</h3>
        <Table stickyHeader>
          <TableHeader>
            <TableRow>
              <TableHead>Render</TableHead>
              <TableHead>Format</TableHead>
              <TableHead numeric>Duration</TableHead>
              <TableHead numeric>Credits</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow selected>
              <TableCell>titles-v4.mp4</TableCell>
              <TableCell>MP4</TableCell>
              <TableCell numeric>00:12</TableCell>
              <TableCell numeric>1,200</TableCell>
              <TableCell>Completed</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>teaser.png</TableCell>
              <TableCell>PNG seq</TableCell>
              <TableCell numeric>00:04</TableCell>
              <TableCell numeric>400</TableCell>
              <TableCell>Completed</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>launch-film.mp4</TableCell>
              <TableCell>MP4</TableCell>
              <TableCell numeric>00:12</TableCell>
              <TableCell numeric>1,200</TableCell>
              <TableCell>Cancelled</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Empty state INSIDE the body (§7.9/§7.12)</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead numeric>Comps</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableEmpty colSpan={2}>No projects yet.</TableEmpty>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
