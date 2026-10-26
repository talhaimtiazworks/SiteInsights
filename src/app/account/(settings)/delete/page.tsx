import type { Metadata } from "next";
import { DeleteAccountClient } from "./delete-client";

export const metadata: Metadata = { title: "Delete account" };

export default function DeleteAccountPage() {
  return <DeleteAccountClient />;
}
