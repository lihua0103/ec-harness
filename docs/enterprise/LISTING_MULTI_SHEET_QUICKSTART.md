# Clinical Listing Multi-Sheet Output - Quick Start Guide

## Overview

This feature merges multiple listing forms into a single Excel file with multiple sheets and applies unified style specifications.

## Core Features

- Auto-generated Contents index page
- Four predefined scenario styles (manual/medical/rbqm/report)
- Auto-added system field columns
- Change tracking (compare with previous version)
- Migration tool (merge existing single-file outputs)

## Quick Start (5 minutes)

### Step 1: Prepare Data

Define outputs dictionary in enterprise_listing_run_code:

```python
# Multiple listings, each becomes a sheet
outputs = {
    "Adverse_Events": ae_df,
    "Vital_Signs": vs_df,
    "Demographics": dm_df
}
```

### Step 2: Publish

Call enterprise_listing_publish:
- project: project path
- scenario: "manual" / "medical" / "rbqm" / "report"
- trackChanges: true (optional)

### Step 3: View Results

Output file: .clinical-listing/output/{scenario}/{SCENARIO}_LISTINGS.xlsx

File structure:
- Contents (auto-generated index)
- Adverse_Events (data sheet 1)
- Vital_Signs (data sheet 2)
- Demographics (data sheet 3)

## Style Preview

### Manual Scenario (Blue Theme)
- Header: Blue (#4472C4)
- System fields: Gray background (#F2F2F2)
- Fields: Flag, Update Details, Review Comments, Initial_Date

### Medical Scenario (Green Theme)
- Header: Green (#70AD47)
- System fields: Light green background (#E2EFDA)
- Fields: Flag, Update Details, Review Comments, Initial_Date, Reviewer

### RBQM Scenario (Orange Theme)
- Header: Orange (#ED7D31)
- System fields: Light orange background (#FCE4D6)
- Fields: Risk Level, Indicator, Threshold, Notes
- Special: Risk Level conditional formatting (Red/Yellow/Green)

### Report Scenario (Blue Theme)
- Header: Blue (#5B9BD5)
- System fields: Light blue background (#DDEBF7)
- Fields: Category, Metric, Value, Notes

## Complete Example

```python
# 1. Inspect project
inspection = enterprise_listing_inspect(project="/path/to/project")

# 2. Prepare data
ae_df = datasets["AE"]
vs_df = datasets["VS"]

# Filter and process...
ae_listing = ae_df[["SUBJID", "AETERM", "AESTDT", "AESEV"]]
vs_listing = vs_df[["SUBJID", "VISIT", "VSORRES", "VSORRESU"]]

# 3. Define multiple outputs
outputs = {
    "Adverse_Events": ae_listing,
    "Vital_Signs": vs_listing
}

# 4. Publish
result = enterprise_listing_publish(
    project="/path/to/project",
    scenario="medical"
)
```

## Migration Tool

If you have multiple separate Excel files:

```
.clinical-listing/output/manual/
├── AE_Listing.xlsx
├── VS_Listing.xlsx
└── DM_Listing.xlsx
```

Call merge tool:

```python
result = enterprise_listing_merge(
    project="/path/to/project",
    scenario="manual"
)
# Output: MANUAL_LISTINGS_MERGED.xlsx
```

## Contents Page

Auto-generated index page contains:

| Column | Description |
|--------|-------------|
| No. | Number |
| Listing | Sheet name |
| Description | Change description (if trackChanges enabled) |
| Rows | Data row count |
| Columns | Column count |
| Status | New / Updated |
| Last Updated | Timestamp |

## System Fields

System fields are automatically added at the end of each DataFrame with empty initial values:

| Scenario | System Fields |
|----------|---------------|
| manual | Flag, Update Details, Review Comments, Initial_Date |
| medical | Flag, Update Details, Review Comments, Initial_Date, Reviewer |
| rbqm | Risk Level, Indicator, Threshold, Notes |
| report | Category, Metric, Value, Notes |

## Technical Architecture

```
worker.py (operation_publish)
    ↓
multi_sheet_writer.py (create_multi_sheet_excel)
    ├─ calculate_changes()          # Change tracking
    ├─ generate_contents_page()     # Generate index
    ├─ Add system field columns
    ├─ Write Excel (pandas ExcelWriter)
    └─ formatter.py (format_workbook)  # Apply styles
        ├─ format_contents_sheet()
        └─ format_data_sheet() × N
            └─ style_spec.py (style definitions)
```

## Version History

- v1.0.0 (2026-08-27): Initial version
  - Multi-sheet output
  - Four scenario styles
  - Change tracking
  - Migration tool

---

Maintainer: DSH Platform Team
Last Updated: 2026-08-27
