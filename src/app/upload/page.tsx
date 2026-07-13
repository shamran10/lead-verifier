import { UploadWorkflow } from "@/components/upload-workflow";

export const metadata = { title: "Upload" };

export default function UploadPage() {
  return (
    <div>
      <p className="eyebrow">New import</p>
      <h1 className="page-title">Upload founder workbook</h1>
      <p className="page-description mb-8 max-w-3xl">
        Preview every supported sheet, inspect normalized domains and candidate
        emails, then confirm the import. Verification does not run in this step.
      </p>
      <UploadWorkflow />
    </div>
  );
}
