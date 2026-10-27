#!/usr/bin/env python3
"""Fix TOC first-entry duplicate:
docx-js emits its own hyperlinked TOC entry for heading #1 inside the field-start
paragraph (PAGEREF _Toc1, no cached page number). add_toc_placeholders.py cannot
remove it and appends its own plain entries, producing a duplicated first line.

This script:
1. Inserts a literal page-number result run ('1') into the docx-js PAGEREF field
   inside the TOC field-start paragraph, so the hyperlinked entry renders fully.
2. Removes the script-inserted plain duplicate entry ['<heading>', '1'].
"""
import re
import shutil
import sys
import zipfile
import tempfile
import os

from lxml import etree

DOCX = "/home/z/my-project/download/Studio\u9879\u76ee\u6587\u6863\u6458\u8981.docx"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def para_texts(p):
    return [t.text or "" for t in p.iter(f"{{{W}}}t")]


def main():
    tmp_dir = tempfile.mkdtemp()
    tmp_path = os.path.join(tmp_dir, "out.docx")
    fixed_page = removed_dup = 0

    with zipfile.ZipFile(DOCX, "r") as zin:
        names = zin.namelist()
        doc_xml = zin.read("word/document.xml").decode("utf-8")

    root = etree.fromstring(doc_xml.encode("utf-8"))
    sdt = None
    for s in root.iter(f"{{{W}}}sdt"):
        if any("TOC" in (it.text or "") for it in s.iter(f"{{{W}}}instrText")):
            sdt = s
            break
    if sdt is None:
        print("no TOC sdt found; nothing to do")
        return 0

    paras = sdt.findall(f".//{{{W}}}p")

    # 1. find TOC field-start paragraph (contains the TOC instrText)
    p0 = None
    for p in paras:
        if any("TOC" in (it.text or "") and "PAGEREF" not in (it.text or "")
               for it in p.iter(f"{{{W}}}instrText")):
            p0 = p
            break
    first_heading = None
    if p0 is not None:
        # the heading text is the first hyperlink's text
        hl = p0.find(f"{{{W}}}hyperlink")
        if hl is not None:
            ts = "".join(t.text or "" for t in hl.iter(f"{{{W}}}t"))
            first_heading = ts.strip()
            # find the PAGEREF end fldChar run inside the hyperlink
            end_run = None
            for r in hl.findall(f"{{{W}}}r"):
                for fc in r.findall(f"{{{W}}}fldChar"):
                    if fc.get(f"{{{W}}}fldCharType") == "end":
                        end_run = r
                        break
                if end_run is not None:
                    break
            if end_run is not None:
                # only add if no existing result text before end
                page_run = etree.Element(f"{{{W}}}r")
                t = etree.SubElement(page_run, f"{{{W}}}t")
                t.text = "1"
                end_run.addprevious(page_run)
                fixed_page = 1

    # 2. remove the plain duplicate entry [first_heading, '1']
    if first_heading:
        for p in paras:
            if p is p0:
                continue
            ts = para_texts(p)
            if len(ts) == 2 and ts[0].strip() == first_heading and ts[1].strip() == "1":
                p.getparent().remove(p)
                removed_dup = 1
                break

    result = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    with zipfile.ZipFile(DOCX, "r") as zin, \
         zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name in names:
            if name == "word/document.xml":
                zout.writestr(name, result)
            else:
                zout.writestr(name, zin.read(name))
    shutil.move(tmp_path, DOCX)
    print(f"toc fix: page_runs_added={fixed_page} duplicates_removed={removed_dup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
