# Multi-Sheet Excel Output - Testing Guide

## Quick Test Setup

### 1. Pull Latest Code

\\\ash
git pull origin feat/clinical/harness
cd packages/enterprise/listing
\\\

### 2. Generate Test Templates

\\\ash
python python/generate_templates.py
\\\

This will create 4 example Excel files in \python/\:
- \	emplate_manual.xlsx\
- \	emplate_medical.xlsx\
- \	emplate_rbqm.xlsx\
- \	emplate_report.xlsx\

### 3. Deploy the Feature (Optional for Testing)

\\\ash
# Dry run first
python deploy_multi_sheet.py --dry-run

# Deploy
python deploy_multi_sheet.py

# Build TypeScript
pnpm build
\\\

## Test Checklist

### Basic Functionality Tests

- [ ] **Test 1: Single Listing Output**
  - Define \esult = df\ in run_code
  - Call publish
  - Verify single sheet + Contents page
  
- [ ] **Test 2: Multi-Listing Output**
  - Define \outputs = {"Sheet1": df1, "Sheet2": df2}\
  - Call publish
  - Verify multiple sheets + Contents page

- [ ] **Test 3: Manual Scenario**
  - scenario="manual"
  - Verify blue theme (#4472C4)
  - Verify system fields: Flag, Update Details, Review Comments, Initial_Date

- [ ] **Test 4: Medical Scenario**
  - scenario="medical"
  - Verify green theme (#70AD47)
  - Verify additional Reviewer field

- [ ] **Test 5: RBQM Scenario**
  - scenario="rbqm"
  - Verify orange theme (#ED7D31)
  - Verify Risk Level, Indicator, Threshold, Notes fields

- [ ] **Test 6: Report Scenario**
  - scenario="report"
  - Verify blue theme (#5B9BD5)
  - Verify Category, Metric, Value, Notes fields

### Advanced Tests

- [ ] **Test 7: Change Tracking**
  - Publish once
  - Modify data
  - Publish again
  - Verify Contents shows "Updated" status
  - Check change log JSON file

- [ ] **Test 8: Merge Tool**
  - Create 3 separate Excel files
  - Call enterprise_listing_merge
  - Verify merged output

- [ ] **Test 9: Large Dataset**
  - Test with 10,000+ rows
  - Check performance (should be < 30s)
  - Verify memory usage

- [ ] **Test 10: Edge Cases**
  - Empty DataFrame
  - Single row DataFrame
  - Very wide DataFrame (100+ columns)
  - Long sheet name (>31 chars, should truncate)

### Visual Inspection

- [ ] Contents page formatting
- [ ] Header colors correct
- [ ] System field backgrounds correct
- [ ] Column widths appropriate
- [ ] Row heights consistent
- [ ] Frozen panes at A2
- [ ] Auto-filters enabled
- [ ] No overlapping text
- [ ] Borders visible

## Sample Test Code

### Test 1: Basic Multi-Sheet

\\\python
# In enterprise_listing_run_code
import pandas as pd

# Create sample data
ae_data = {
    'Subject_ID': ['001', '002', '003'],
    'AE_Term': ['Headache', 'Nausea', 'Fatigue'],
    'Severity': ['Mild', 'Moderate', 'Mild']
}

vs_data = {
    'Subject_ID': ['001', '002', '003'],
    'BP_Systolic': [120, 125, 130],
    'Heart_Rate': [72, 75, 78]
}

outputs = {
    'Adverse_Events': pd.DataFrame(ae_data),
    'Vital_Signs': pd.DataFrame(vs_data)
}

# Then call enterprise_listing_publish
\\\

### Test 2: Change Tracking

\\\python
# First run
outputs = {
    'Test': pd.DataFrame({'A': [1, 2, 3]})
}
# Publish -> file created

# Second run (add more rows)
outputs = {
    'Test': pd.DataFrame({'A': [1, 2, 3, 4, 5]})
}
# Publish -> Contents should show "新增 2 行"
\\\

## Expected Output Structure

\\\
.clinical-listing/output/{scenario}/
├── {SCENARIO}_LISTINGS.xlsx
│   ├── Contents (tab)
│   ├── Sheet1 (tab)
│   └── Sheet2 (tab)
└── {SCENARIO}_LISTINGS_changes.json (if trackChanges=true)
\\\

## Performance Benchmarks

| Dataset Size | Expected Time | Memory Usage |
|--------------|---------------|--------------|
| < 1K rows    | < 1 second    | < 50 MB      |
| 1K-10K rows  | 1-5 seconds   | 50-200 MB    |
| > 10K rows   | 5-30 seconds  | 200-500 MB   |

## Common Issues & Solutions

### Issue: Import Error for styles module

**Solution**: Make sure \python/styles/__init__.py\ exists

### Issue: Styles not applied

**Solution**: Check openpyxl version >= 3.0.0

\\\ash
pip show openpyxl
# If < 3.0, upgrade:
pip install --upgrade openpyxl
\\\

### Issue: Permission denied during deploy

**Solution**: Close Excel if any template files are open

### Issue: Sheet name truncated

**Expected**: Excel limits sheet names to 31 characters

## Rollback Instructions

If testing reveals issues:

\\\ash
cd packages/enterprise/listing
python deploy_multi_sheet.py --rollback
pnpm build
\\\

## Test Report Template

\\\
Test Date: _________
Tester: _________
Branch: feat/clinical/harness
Commit: 787ef96

Results:
[ ] All basic tests passed
[ ] All advanced tests passed
[ ] Visual inspection passed
[ ] Performance acceptable

Issues Found:
1. _________
2. _________

Overall Status: [ ] PASS  [ ] FAIL

Notes:
_________
\\\

## Next Steps After Testing

1. Document any issues found
2. If all tests pass, proceed with deployment
3. If issues found, report to development team
4. Update documentation based on test findings

---

**For questions or issues, refer to:**
- LISTING_MULTI_SHEET_QUICKSTART.md
- LISTING_MULTI_SHEET_SPEC.md
- MULTI_SHEET_README.md
