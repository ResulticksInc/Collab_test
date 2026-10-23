"use client";
import CoLabShell from "./colab/CoLabShell";
import { useCoLab0 } from "./colab/session/useCoLab0";
import { useCoLab1 } from "./colab/session/useCoLab1";
import { useCoLab2 } from "./colab/session/useCoLab2";
import { useCoLab3 } from "./colab/session/useCoLab3";
import { useCoLab4 } from "./colab/session/useCoLab4";
import { useCoLab5 } from "./colab/session/useCoLab5";
import { useCoLab6 } from "./colab/session/useCoLab6";

// CoLabV1 has been split: the ~11k-line component body now lives in the
// useCoLab0..6 session hooks (colab/session/*) and the render tree in
// colab/CoLabShell.tsx. This file only assembles the hook chain and
// hands the accumulated session object to the shell.
export default function CoLabV1() {
  const s0 = useCoLab0();
  const s1 = useCoLab1(s0);
  const s01 = { ...s0, ...s1 };
  const s2 = useCoLab2(s01);
  const s012 = { ...s01, ...s2 };
  const s3 = useCoLab3(s012);
  const s0123 = { ...s012, ...s3 };
  const s4 = useCoLab4(s0123);
  const s01234 = { ...s0123, ...s4 };
  const s5 = useCoLab5(s01234);
  const s012345 = { ...s01234, ...s5 };
  const s6 = useCoLab6(s012345);
  const s = { ...s012345, ...s6 };
  return <CoLabShell s={s} />;
}
