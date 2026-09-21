# =====================================================================
# 【知识库样本】PK Mapping 主编程人写交付程序（风格参照，脱敏版）
#
# 来源：某双盲 BE 项目主编程（人工编码）最终交付 R 程序；r_pk 车道 QC 独立编程
#       与其输出哈希全等（对端）。用途：AI/人新写同类程序时的表达层参照——
#       思维链/骨架/习惯的蒸馏结论见 ../listing-pk-mapping.md L3 节。
# 脱敏：项目名/方案号/作者/密码/中心与实验室名已替换为中性占位符
#       （PROJECTKEY/STUDYCODE/AUTHOR/ZIP_PASSWORD），运行路径为服务器形态占位；
#       其余（结构/函数/管道写法/值域枚举/注释风格）保留人写原貌。
# 注意：本样本刻意保留两处环境依赖原貌（dmy_hms/round_half_up 无显式 library、
#       setwd+裸 unzip），复用前先过 L3"差异清单"——风格照学、依赖改造。
# =====================================================================

library(haven)
library(tools)
library(readxl)
library(tidyverse)
library(digest)
library(fuzzyjoin)
library(tokenizers)
library(scales)
library(openxlsx)
library(Rcompare)

# 作者
Author <- "AUTHOR"

# 项目名称
ProjectName <- "PROJECTKEY"

studyCode   <- "STUDYCODE"
environment <- "PROD"
listingType <- "rawdata Listing"
subjectfile <- "crViewer.xls"
sysType     <- "Rave"

foldername  <- "20260911"
folder_path <- "/mnt/project/PROJECTKEY_ROOT/Project_Data/01_Raw_sas/PK Mapping/"
als_path = "/mnt/project/PROJECTKEY_ROOT/SAS_Program/SAS_program/rawdata listing/alsv1.0.xlsx"
pk_data_file = file.path("/mnt/project/PROJECTKEY_ROOT/Project_Data/02_Raw_csv/PK Mapping/",foldername,"PROJECTKEY_PK Data_11Sep2026.xlsx")

password <- "ZIP_PASSWORD"

# -------- 工具函数 -----------------------------------------------------------

drop_sys_varible_rave <- function(df) {
  sysvarible <- c("environmentName","SiteGroup","folderid","instanceId","DataPageId",
                  "RecordId","MinCreated","MaxUpdated","SaveTS","StudyEnvSiteNumber",
                  "projectid","studyid","StudySiteId","siteid","TargetDays","subjectId",
                  "RecordDate","NOWDAT")
  codelist_suffixes <- c("_STD","_RAW","_INT","_YYYY","_MM","_DD")

  col_names <- colnames(df)
  col_names <- col_names[!col_names %in% sysvarible]
  for (suf in codelist_suffixes) {
    col_names <- col_names[!grepl(paste0(suf, "$"), col_names)]
  }
  df[, col_names, drop = FALSE]
}

read_sas_folder <- function(folder_path, foldername, clear_sasdata = TRUE) {
  data_path <- file.path(folder_path, foldername)
  setwd(data_path)

  save_filename <- paste0("sas_data_", foldername, ".RData")

  if (!file.exists(file.path(data_path, save_filename))) {
    system(sprintf("unzip -P %s *PROJECTKEY*.zip -d ./",password) )
    all_files <- list.files(data_path, pattern = "\\.sas7bdat$", full.names = TRUE)
    datasets <- lapply(all_files, function(x) haven::read_sas(x))
    names(datasets) <- toupper(tools::file_path_sans_ext(basename(all_files)))

    if (clear_sasdata) file.remove(all_files)
    save(datasets, file = save_filename)
  }
  save_filename
}

alsmapping_saslabel <- function(datasets, alspath = NA) {
  if (!is.na(alspath)) {
    data <- read_excel(alspath, sheet = "Fields") %>% select(FormOID, FieldOID, PreText)
  }
  for (name in names(datasets)) {
    df <- datasets[[name]]
    df <- drop_sys_varible_rave(df)
    if (!is.na(alspath)) {
      df_label <- data %>% filter(FormOID == name)
      for (colname in names(df)) {
        taglabel <- df_label %>% filter(FieldOID == colname) %>% pull(PreText)
        if (length(taglabel) > 0 && !is.na(taglabel)) {
          attr(df[[colname]], "label") <- taglabel
        }
      }
    }
    datasets[[name]] <- df
  }
  datasets
}

# -------- 读取数据 -----------------------------------------------------------

save_filename <- read_sas_folder(folder_path, foldername)
load(save_filename)

rawdata <- alsmapping_saslabel(datasets, alspath = als_path)
PK_data <- read_excel(pk_data_file) %>%
  mutate(`Concentration (ng/mL)` = case_when(
    `Concentration (ng/mL)` == "BQL" ~ "BQL",
    T ~ as.character(round(as.numeric(`Concentration (ng/mL)`),5))
  ))

PC_ALL <- rbind(
  rawdata$PC1 %>% select(Subject,Folder,PC1TPT,PCDAT),
  rawdata$PC2 %>% select(Subject,Folder,PCDAT) %>% mutate(PC1TPT = "UN"),
  rawdata$PC3 %>% select(Subject,Folder,PC3TPT,PCDAT) %>% rename("PC1TPT" = "PC3TPT")
) %>%
  mutate(
    Period = case_when(
      Folder == "D1" ~ 1,
      Folder == "D6" ~ 2,
      Folder == "D11" ~ 3,
      Folder == "D16" ~ 4),
    nt = case_when(
      PC1TPT == "within 2 hours prior to dosing (pre-dose)" ~ 0.000,
      PC1TPT == "0.166H（10min）Post dosing" ~ 0.166,
      PC1TPT == "0.25Hours Post dosing" ~ 0.25,
      PC1TPT == "0.50Hours Post Dosing" ~ 0.50,
      PC1TPT == "0.75Hours Post dosing" ~ 0.75,
      PC1TPT == "1.00Hours Post Dosing" ~ 1.00,
      PC1TPT == "1.25Hours Post Dosing" ~ 1.25,
      PC1TPT == "1.50Hours Post Dosing" ~ 1.50,
      PC1TPT == "1.75Hours Post Dosing" ~ 1.75,
      PC1TPT == "2.00Hours Post Dosing" ~ 2.00,
      PC1TPT == "2.25Hours Post Dosing" ~ 2.25,
      PC1TPT == "2.50Hours Post Dosing" ~ 2.50,
      PC1TPT == "2.75Hours Post Dosing" ~ 2.75,
      PC1TPT == "3.00Hours Post Dosing" ~ 3.00,
      PC1TPT == "3.25Hours Post Dosing" ~ 3.25,
      PC1TPT == "3.50Hours Post Dosing" ~ 3.50,
      PC1TPT == "3.75Hours Post Dosing" ~ 3.75,
      PC1TPT == "4.00Hours Post Dosing" ~ 4.00,
      PC1TPT == "4.25Hours Post Dosing" ~ 4.25,
      PC1TPT == "4.50Hours Post Dosing" ~ 4.50,
      PC1TPT == "4.75Hours Post Dosing" ~ 4.75,
      PC1TPT == "5.00Hours Post Dosing" ~ 5.00,
      PC1TPT == "5.25Hours Post Dosing" ~ 5.25,
      PC1TPT == "5.50Hours Post Dosing" ~ 5.50,
      PC1TPT == "5.75Hours Post Dosing" ~ 5.75,
      PC1TPT == "6.00Hours Post Dosing" ~ 6.00,
      PC1TPT == "6.50Hours Post Dosing" ~ 6.50,
      PC1TPT == "7.00Hours Post Dosing" ~ 7.00,
      PC1TPT == "8.00Hours Post Dosing" ~ 8.00,
      PC1TPT == "9.00Hours Post Dosing" ~ 9.00,
      PC1TPT == "10.00Hours Post Dosing" ~ 10.00,
      PC1TPT == "12.00Hours Post Dosing" ~ 12.00,
      PC1TPT == "16.00Hours Post Dosing" ~ 16.00,
      PC1TPT == "20.00Hours Post Dosing" ~ 20.00,
      PC1TPT == "24.00Hours Post Dosing" ~ 24.00,
      TRUE ~ NA_real_
    )
  ) %>% select(-Folder)

EC_ALL <- rawdata$EC %>% select(Subject,Folder,FolderName,ECFSTYN1,ECSTDAT,ECDSTXT,ECDOSU) %>%
  mutate(
    Period = case_when(
      Folder == "D1" ~ 1,
      Folder == "D6" ~ 2,
      Folder == "D11" ~ 3,
      Folder == "D16" ~ 4
    ),
    DOSE = paste(ECDSTXT,ECDOSU)
  ) %>%
  select(Subject,Folder,FolderName,ECFSTYN1,ECSTDAT,Period,DOSE)

PK_data_cohrt <-
  PK_data %>% left_join(
    rawdata$RAND %>% select(Subject,RAND_ID,REGIME_NAME) %>%
      rename("ScreenId" = "Subject"),by = c("Subject" = "RAND_ID")
  ) %>%
  left_join(
    rawdata$DM %>% select(Subject,AGE,SEX)
    ,by = c("ScreenId" = "Subject")
  ) %>%
  left_join(
    rawdata$VS2 %>% select(Subject,HEIGHT,WEIGHT,BMI)
    ,by = c("ScreenId" = "Subject")
  ) %>%
  left_join(
    EC_ALL
    ,by = c("ScreenId" = "Subject","Period")
  ) %>%
  left_join(
    PC_ALL,
    by  = c("ScreenId" = "Subject","Period",`Sampling Time(h)` = "nt")
  ) %>%
  mutate(
    UNIT = "ng/mL",
    RT = if_else(round_half_up(as.numeric(dmy_hms(PCDAT) - dmy_hms(ECSTDAT), units = "hours"), 3) <0 ,0,round_half_up(as.numeric(dmy_hms(PCDAT) - dmy_hms(ECSTDAT), units = "hours"), 3) ),
    SEQ = "",
    TRT = ""
  ) %>%
  rename(
    "STUDYID" = "Study ID",
    "SUBJID" = "Subject",
    "COHORT" = "REGIME_NAME",
    "FAST" = "ECFSTYN1",
    "PERIOD" = "Period",
    "VISIT" = "FolderName",
    "ANALYTE" = "Analyte",
    "NTPT" = "PC1TPT",
    "NT" = "Sampling Time(h)",
    "Concentration" = "Concentration (ng/mL)",
    "LLOQ" = "LLOQ(ng/mL)",
    "ULOQ" = "ULOQ(ng/mL)",
    "COMMENTS" = "Comments"
  ) %>%
  select(
    STUDYID,
    SUBJID,
    COHORT,
    FAST,
    SEQ,
    TRT,
    PERIOD,
    VISIT,
    ANALYTE,
    DOSE,
    NTPT,
    NT,
    RT,
    Concentration,
    UNIT,
    LLOQ,
    ULOQ,
    SEX,
    AGE,
    HEIGHT,
    WEIGHT,
    BMI,
    COMMENTS
  )

attr(PK_data_cohrt$STUDYID, "label")       <- "Study ID"
attr(PK_data_cohrt$SUBJID, "label")        <- "Participant"
attr(PK_data_cohrt$COHORT, "label")        <- "Cohort"
attr(PK_data_cohrt$FAST, "label")          <- "Fast"
attr(PK_data_cohrt$SEQ, "label")           <- "Sequence"
attr(PK_data_cohrt$TRT, "label")           <- "Treatment"
attr(PK_data_cohrt$PERIOD, "label")        <- "Period"
attr(PK_data_cohrt$VISIT, "label")         <- "Visit"
attr(PK_data_cohrt$ANALYTE, "label")       <- "Analyte"
attr(PK_data_cohrt$DOSE, "label")          <- "Dose"
attr(PK_data_cohrt$NTPT, "label")          <- "Nominal Sampling Time Point"
attr(PK_data_cohrt$NT, "label")            <- "Sampling Time (h)"
attr(PK_data_cohrt$RT, "label")            <- "RT"
attr(PK_data_cohrt$Concentration, "label") <- "Concentration"
attr(PK_data_cohrt$UNIT, "label")          <- "Unit"
attr(PK_data_cohrt$LLOQ, "label")          <- "LLOQ"
attr(PK_data_cohrt$ULOQ, "label")          <- "ULOQ"
attr(PK_data_cohrt$SEX, "label")           <- "Sex"
attr(PK_data_cohrt$AGE, "label")           <- "Age"
attr(PK_data_cohrt$HEIGHT, "label")        <- "Height"
attr(PK_data_cohrt$WEIGHT, "label")        <- "Weight"
attr(PK_data_cohrt$BMI, "label")           <- "BMI"
attr(PK_data_cohrt$COMMENTS, "label")      <- "Comments"

setwd("/mnt/project/PROJECTKEY_ROOT/Output/04_Out/PK Mapping")

saveRDS(object = PK_data_cohrt,
        file = "/mnt/project/PROJECTKEY_ROOT/Output/04_Out/PK Mapping/PROJECTKEY_PK Mapping_AUTHOR_20260911-prod.rds"
)

BIND <- read_excel("/mnt/project/PROJECTKEY_ROOT/SAS_Program/SAS_program/PK Mapping/编盲.xlsx",col_types = c("text","text"))

PK_Mapping_binded <- PK_data_cohrt %>%
  left_join(BIND %>% select(SUBJID,BLINDID),by = "SUBJID") %>%
  select(-SEQ,-TRT,-HEIGHT,-BMI,-WEIGHT,-SEX,-AGE,-SUBJID) %>%
  rename("SUBJID" = "BLINDID") %>%
  select(STUDYID,SUBJID,everything()) %>%
  arrange(SUBJID,PERIOD,RT)

#
# cmp <- datasetQC::qc_compare("PROJECTKEY PK Mapping_AUTHOR_20260724.rds",qc = "PROJECTKEY PK Mapping_AUTHOR.rds")
#
# datasetQC::qc_report(cmp,"PROJECTKEY PK Mapping QC Report.pdf")
#

output_f <- "PK_Mapping_binded_20260911.xlsx"

openxlsx::write.xlsx(
  PK_Mapping_binded,
  file = output_f,
  sheetName = "PK_Mapping",
  overwrite = TRUE
)

output_f1 <- "PK_Mapping_unbinded_20260911.xlsx"

openxlsx::write.xlsx(
  PK_data_cohrt,
  file = output_f1,
  sheetName = "PK_Mapping",
  overwrite = TRUE
)
