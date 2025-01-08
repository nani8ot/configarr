// those must be run first!
import "dotenv/config";
import { getEnvs, initEnvs } from "./env";
initEnvs();

import fs from "node:fs";
import { MergedCustomFormatResource } from "./__generated__/mergedTypes";
import { configureApi, getUnifiedClient, unsetApi } from "./clients/unified-client";
import { getConfig, mergeConfigsAndTemplates } from "./config";
import { calculateCFsToManage, loadCustomFormatDefinitions, loadServerCustomFormats, manageCf } from "./custom-formats";
import { logHeading, logger } from "./logger";
import { calculateMediamanagementDiff, calculateNamingDiff } from "./media-management";
import { calculateQualityDefinitionDiff, loadQualityDefinitionFromServer } from "./quality-definitions";
import { calculateQualityProfilesDiff, loadQualityProfilesFromServer } from "./quality-profiles";
import { cloneRecyclarrTemplateRepo } from "./recyclarr-importer";
import { cloneTrashRepo, loadQualityDefinitionFromTrash } from "./trash-guide";
import { ArrType } from "./types/common.types";
import { InputConfigArrInstance } from "./types/config.types";
import { TrashQualityDefintion } from "./types/trashguide.types";

const pipeline = async (value: InputConfigArrInstance, arrType: ArrType) => {
  const api = getUnifiedClient();

  const { config } = await mergeConfigsAndTemplates(value, arrType);

  const idsToManage = calculateCFsToManage(config);
  logger.debug(Array.from(idsToManage), `CustomFormats to manage`);

  const mergedCFs = await loadCustomFormatDefinitions(idsToManage, arrType, config.customFormatDefinitions || []);

  let serverCFs = await loadServerCustomFormats();
  logger.info(`CustomFormats on server: ${serverCFs.length}`);

  const serverCFMapping = serverCFs.reduce((p, c) => {
    p.set(c.name!, c);
    return p;
  }, new Map<string, MergedCustomFormatResource>());

  const cfUpdateResult = await manageCf(mergedCFs, serverCFMapping, idsToManage);

  // add missing CFs to list because we need it for further steps
  // serverCFs.push(...cfUpdateResult.createCFs);
  if (cfUpdateResult.createCFs.length > 0 || cfUpdateResult.updatedCFs.length > 0) {
    // refresh cfs
    serverCFs = await loadServerCustomFormats();
  }

  logger.info(`CustomFormats synchronized`);

  const qualityDefinition = config.quality_definition?.type;

  let serverQD = await loadQualityDefinitionFromServer();

  if (qualityDefinition) {
    let qdTrash: TrashQualityDefintion;

    switch (qualityDefinition) {
      case "anime":
        qdTrash = await loadQualityDefinitionFromTrash("anime", "SONARR");
        break;
      case "series":
        qdTrash = await loadQualityDefinitionFromTrash("series", "SONARR");
        break;
      case "movie":
        qdTrash = await loadQualityDefinitionFromTrash("movie", "RADARR");
        break;
      default:
        throw new Error(`Unsupported quality defintion ${qualityDefinition}`);
    }

    const { changeMap, create, restData } = calculateQualityDefinitionDiff(serverQD, qdTrash, config.quality_definition?.preferred_ratio);

    if (changeMap.size > 0) {
      if (getEnvs().DRY_RUN) {
        logger.info("DryRun: Would update QualityDefinitions.");
      } else {
        logger.info(`Diffs in quality definitions found`, changeMap.values());
        await api.updateQualityDefinitions(restData);
        // refresh QDs
        serverQD = await loadQualityDefinitionFromServer();
        logger.info(`Updated QualityDefinitions`);
      }
    } else {
      logger.info(`QualityDefinitions do not need update!`);
    }

    if (create.length > 0) {
      logger.info(`Currently not implemented this case for quality definitions.`);
    }
  } else {
    logger.info(`No QualityDefinition configured.`);
  }

  const namingDiff = await calculateNamingDiff(config.media_naming);

  if (namingDiff) {
    if (getEnvs().DRY_RUN) {
      logger.info("DryRun: Would update MediaNaming.");
    } else {
      // TODO this will need a radarr/sonarr separation for sure to have good and correct typings
      await api.updateNaming(namingDiff.updatedData.id! + "", namingDiff.updatedData as any); // Ignore types
      logger.info(`Updated MediaNaming`);
    }
  }

  const managementDiff = await calculateMediamanagementDiff(config.media_management);

  if (managementDiff) {
    if (getEnvs().DRY_RUN) {
      logger.info("DryRun: Would update MediaManagement.");
    } else {
      // TODO this will need a radarr/sonarr separation for sure to have good and correct typings
      await api.updateMediamanagement(managementDiff.updatedData.id! + "", managementDiff.updatedData as any); // Ignore types
      logger.info(`Updated MediaManagement`);
    }
  }

  // calculate diff from server <-> what we want to be there
  const serverQP = await loadQualityProfilesFromServer();
  const { changedQPs, create, noChanges } = await calculateQualityProfilesDiff(mergedCFs, config, serverQP, serverQD, serverCFs);

  if (getEnvs().DEBUG_CREATE_FILES) {
    create.concat(changedQPs).forEach((e, i) => {
      fs.writeFileSync(`debug/test${i}.json`, JSON.stringify(e, null, 2), "utf-8");
    });
  }

  logger.info(`QualityProfiles: Create: ${create.length}, Update: ${changedQPs.length}, Unchanged: ${noChanges.length}`);

  if (!getEnvs().DRY_RUN) {
    for (const element of create) {
      try {
        const newProfile = await api.createQualityProfile(element);
        logger.info(`Created QualityProfile: ${newProfile.name}`);
      } catch (error: any) {
        logger.error(`Failed creating QualityProfile (${element.name})`);
        throw error;
      }
    }

    for (const element of changedQPs) {
      try {
        const newProfile = await api.updateQualityProfile("" + element.id, element);
        logger.info(`Updated QualityProfile: ${newProfile.name}`);
      } catch (error: any) {
        logger.error(`Failed updating QualityProfile (${element.name})`);
        throw error;
      }
    }
  } else if (create.length > 0 || changedQPs.length > 0) {
    logger.info("DryRun: Would create/update QualityProfiles.");
  }
};

const run = async () => {
  if (getEnvs().DRY_RUN) {
    logger.info("DryRun: Running in dry-run mode!");
  }

  const applicationConfig = getConfig();

  await cloneRecyclarrTemplateRepo();
  await cloneTrashRepo();

  // TODO currently this has to be run sequentially because of the centrally configured api

  const sonarrConfig = applicationConfig.sonarr;

  if (sonarrConfig == null || Array.isArray(sonarrConfig) || typeof sonarrConfig !== "object" || Object.keys(sonarrConfig).length <= 0) {
    logHeading(`No Sonarr instances defined.`);
  } else {
    logHeading(`Processing Sonarr ...`);

    for (const [instanceName, instance] of Object.entries(sonarrConfig)) {
      logger.info(`Processing Sonarr Instance: ${instanceName}`);
      await configureApi("SONARR", instance.base_url, instance.api_key);
      await pipeline(instance, "SONARR");
      unsetApi();
    }
  }

  const radarrConfig = applicationConfig.radarr;

  if (radarrConfig == null || Array.isArray(radarrConfig) || typeof radarrConfig !== "object" || Object.keys(radarrConfig).length <= 0) {
    logHeading(`No Radarr instances defined.`);
  } else {
    logHeading(`Processing Radarr ...`);

    for (const [instanceName, instance] of Object.entries(radarrConfig)) {
      logger.info(`Processing Radarr Instance: ${instanceName}`);
      await configureApi("RADARR", instance.base_url, instance.api_key);
      await pipeline(instance, "RADARR");
      unsetApi();
    }
  }

  const whisparrConfig = applicationConfig.whisparr;

  if (
    whisparrConfig == null ||
    Array.isArray(whisparrConfig) ||
    typeof whisparrConfig !== "object" ||
    Object.keys(whisparrConfig).length <= 0
  ) {
    logHeading(`No Whisparr instances defined.`);
  } else {
    logHeading(`Processing Whisparr ...`);

    for (const [instanceName, instance] of Object.entries(whisparrConfig)) {
      logger.info(`Processing Whisparr Instance: ${instanceName}`);
      await configureApi("WHISPARR", instance.base_url, instance.api_key);
      await pipeline(instance, "WHISPARR");
      unsetApi();
    }
  }

  const readarrConfig = applicationConfig.readarr;

  if (
    readarrConfig == null ||
    Array.isArray(readarrConfig) ||
    typeof readarrConfig !== "object" ||
    Object.keys(readarrConfig).length <= 0
  ) {
    logHeading(`No Readarr instances defined.`);
  } else {
    logHeading(`Processing Readarr ...`);

    for (const [instanceName, instance] of Object.entries(readarrConfig)) {
      logger.info(`Processing Readarr Instance: ${instanceName}`);
      await configureApi("READARR", instance.base_url, instance.api_key);
      await pipeline(instance, "READARR");
      unsetApi();
    }
  }
};

run();
