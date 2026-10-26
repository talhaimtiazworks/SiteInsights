import type { Metadata } from "next";
import { ProfessionalProfileClient } from "./professional-profile-client";

export const metadata: Metadata = { title: "Professional profile" };

export default function ProfessionalProfilePage() {
  return <ProfessionalProfileClient />;
}
