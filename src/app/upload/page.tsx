import { UploadWorkflow } from "@/components/upload-workflow";

export const metadata = { title: "Upload" };

export default function UploadPage() {
  return (
    <div>
      <p className="eyebrow">New import</p>
      <h1 className="page-title">Upload founder workbook</h1>
      <p className="page-description mb-8 max-w-3xl">
        Import Y Combinator or eligible 2025–2026 500 Global, Techstars, and
        MassChallenge, and Antler founder data,
        inspect normalized domains and source metadata, then confirm the import.
        Accelerator workbooks use the same source-aware metadata contract.
        Verification does not run in this step.
      </p>
      <UploadWorkflow />
    </div>
  );
}
