#!/usr/bin/env python3
"""
patch_musl_resolv.py — Deterministic AArch64 static-musl DNS path patcher for Codex Android.

Static musl binaries (`aarch64-unknown-linux-musl`) hardcode `"/etc/resolv.conf\\0"` inside
`__lookup_resolv_open`, which does not exist on unrooted Android (`ENOENT` -> fallback to
`127.0.0.1:53` -> DNS failure).

This tool locates the single `ADRP Xd, page("/etc/resolv.conf") + ADD Xd, Xd, #lo12` pair
in executable `.text`, places `"/data/data/com.ce.ide/files/etc/resolv.conf\\0"` into unused
page-alignment zero-padding at the tail of `PT_LOAD[0]` (`PF_R | PF_X`), extends `p_filesz`
and `p_memsz` safely within the inter-segment gap, and updates the `ADRP + ADD` instructions.
"""

import os
import struct
import sys

OLD_STR = b"/etc/resolv.conf\x00"
NEW_STR = b"/data/data/com.ce.ide/files/etc/resolv.conf\x00"


def encode_adrp(rd: int, pc: int, target_va: int) -> int:
    diff_pages = ((target_va & ~0xFFF) - (pc & ~0xFFF)) >> 12
    if not -(1 << 20) <= diff_pages < (1 << 20):
        raise ValueError(f"ADRP page delta out of +-4GiB range: {diff_pages}")
    imm = diff_pages & ((1 << 21) - 1)
    immlo = imm & 0x3
    immhi = (imm >> 2) & 0x7FFFF
    return 0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 0x1F)


def encode_add_imm12_x(rd: int, rn: int, imm12: int) -> int:
    if not (0 <= imm12 <= 0xFFF):
        raise ValueError(f"ADD imm12 out of range: {imm12:#x}")
    return 0x91000000 | ((imm12 & 0xFFF) << 10) | ((rn & 0x1F) << 5) | (rd & 0x1F)


def patch_elf(path: str) -> None:
    with open(path, "rb") as f:
        data = bytearray(f.read())

    if data[:4] != b"\x7fELF" or data[4] != 2 or struct.unpack_from("<H", data, 18)[0] != 183:
        raise RuntimeError(f"{path}: not an ELF64 AArch64 binary")

    if NEW_STR in data:
        print(f"[patch_musl_resolv] {os.path.basename(path)}: already patched ({NEW_STR.decode().rstrip(chr(0))})")
        return

    e_phoff = struct.unpack_from("<Q", data, 32)[0]
    e_phentsize, e_phnum = struct.unpack_from("<HH", data, 54)

    pt_loads = []
    for i in range(e_phnum):
        ph_pos = e_phoff + i * e_phentsize
        p_type, p_flags, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align = struct.unpack_from(
            "<IIQQQQQQ", data, ph_pos
        )
        if p_type == 1:
            pt_loads.append(
                {
                    "ph_pos": ph_pos,
                    "flags": p_flags,
                    "offset": p_offset,
                    "vaddr": p_vaddr,
                    "paddr": p_paddr,
                    "filesz": p_filesz,
                    "memsz": p_memsz,
                    "align": p_align,
                }
            )

    pt_loads.sort(key=lambda s: s["offset"])

    def off_to_va(foff: int):
        for s in pt_loads:
            if s["offset"] <= foff < s["offset"] + s["filesz"]:
                return s["vaddr"] + (foff - s["offset"])
        return None

    str_off = data.find(OLD_STR)
    if str_off == -1:
        raise RuntimeError(f"{path}: {OLD_STR!r} not found")
    if data.find(OLD_STR, str_off + 1) != -1:
        raise RuntimeError(f"{path}: multiple occurrences of {OLD_STR!r}; refusing ambiguous patch")

    target_va = off_to_va(str_off)
    if target_va is None:
        raise RuntimeError(f"{path}: {OLD_STR!r} at {str_off:#x} is outside PT_LOAD segments")

    target_page = target_va & ~0xFFF
    target_lo = target_va & 0xFFF

    xrefs = []
    mv = memoryview(data)
    for s in pt_loads:
        if not (s["flags"] & 0x1):  # PF_X
            continue
        start = s["offset"]
        end = start + (s["filesz"] & ~3)
        for pos in range(start, end - 4, 4):
            insn = struct.unpack_from("<I", mv, pos)[0]
            if (insn & 0x9F000000) == 0x90000000:
                pc = s["vaddr"] + (pos - start)
                immlo = (insn >> 29) & 0x3
                immhi = (insn >> 5) & 0x7FFFF
                imm = (immhi << 2) | immlo
                if imm & (1 << 20):
                    imm -= 1 << 21
                page = (pc & ~0xFFF) + (imm << 12)
                if page == target_page:
                    rd = insn & 0x1F
                    for k in range(1, 5):
                        if pos + 4 * k >= end:
                            break
                        i2 = struct.unpack_from("<I", mv, pos + 4 * k)[0]
                        if (i2 & 0xFFC00000) == 0x91000000:
                            rn = (i2 >> 5) & 0x1F
                            imm12 = (i2 >> 10) & 0xFFF
                            if rn == rd and imm12 == target_lo:
                                xrefs.append((pos, pos + 4 * k, pc, rd, i2 & 0x1F))
                                break

    if len(xrefs) != 1:
        raise RuntimeError(f"{path}: expected 1 ADRP+ADD xref to /etc/resolv.conf, found {len(xrefs)}: {xrefs}")

    adrp_off, add_off, adrp_pc, adrp_rd, add_rd = xrefs[0]

    # Allocate cave in the inter-segment zero padding right after PT_LOAD[0] (PF_R | PF_X)
    exec_seg = next(s for s in pt_loads if s["flags"] & 0x1)
    seg_idx = pt_loads.index(exec_seg)
    next_seg = pt_loads[seg_idx + 1] if seg_idx + 1 < len(pt_loads) else None

    cave_off = (exec_seg["offset"] + exec_seg["filesz"] + 0x3F) & ~0x3F
    needed_end_off = cave_off + len(NEW_STR)
    cave_va = exec_seg["vaddr"] + (cave_off - exec_seg["offset"])
    needed_end_va = cave_va + len(NEW_STR)

    if next_seg is not None:
        if needed_end_off > next_seg["offset"]:
            raise RuntimeError(
                f"{path}: insufficient file gap after PT_LOAD[{seg_idx}] "
                f"(need {needed_end_off:#x}, next offset {next_seg['offset']:#x})"
            )
        if needed_end_va > next_seg["vaddr"]:
            raise RuntimeError(
                f"{path}: insufficient VA gap after PT_LOAD[{seg_idx}] "
                f"(need {needed_end_va:#x}, next vaddr {next_seg['vaddr']:#x})"
            )

    if any(b != 0 for b in data[cave_off:needed_end_off]):
        raise RuntimeError(f"{path}: cave region {cave_off:#x}..{needed_end_off:#x} is not all zeroes")

    # Write string into cave & extend PT_LOAD[0] filesz/memsz to cover it
    data[cave_off:needed_end_off] = NEW_STR
    new_filesz = needed_end_off - exec_seg["offset"]
    new_memsz = max(exec_seg["memsz"], new_filesz)
    ph_pos = exec_seg["ph_pos"]
    struct.pack_into("<QQ", data, ph_pos + 32, new_filesz, new_memsz)

    # Patch ADRP + ADD to point to cave_va
    new_adrp = encode_adrp(adrp_rd, adrp_pc, cave_va)
    new_add = encode_add_imm12_x(add_rd, adrp_rd, cave_va & 0xFFF)
    struct.pack_into("<I", data, adrp_off, new_adrp)
    struct.pack_into("<I", data, add_off, new_add)

    tmp_path = path + ".patched"
    with open(tmp_path, "wb") as f:
        f.write(data)
    os.chmod(tmp_path, 0o755)
    os.replace(tmp_path, path)
    print(
        f"[patch_musl_resolv] Patched {os.path.basename(path)}: "
        f"adrp@{adrp_off:#x} + add@{add_off:#x} -> cave_off={cave_off:#x} (va={cave_va:#x})"
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: patch_musl_resolv.py <elf-path> [...]")
    for p in sys.argv[1:]:
        patch_elf(p)
