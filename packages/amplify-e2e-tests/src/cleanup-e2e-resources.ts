/* eslint-disable spellcheck/spell-checker, camelcase, jsdoc/require-jsdoc, @typescript-eslint/no-explicit-any */
import path from 'path';
import { CodeBuild } from 'aws-sdk';
import { config } from 'dotenv';
import yargs from 'yargs';
import * as aws from 'aws-sdk';
import _ from 'lodash';
import fs from 'fs-extra';
import { deleteS3Bucket, sleep } from 'amplify-category-api-e2e-core';

type TestRegion = {
  name: string;
  optIn: boolean;
};

const repoRoot = path.join(__dirname, '..', '..', '..');
const supportedRegionsPath = path.join(repoRoot, 'scripts', 'e2e-test-regions.json');
const suportedRegions: TestRegion[] = JSON.parse(fs.readFileSync(supportedRegionsPath, 'utf-8'));
const testRegions = suportedRegions.map((region) => region.name);

const reportPathDir = path.normalize(path.join(__dirname, '..', 'amplify-e2e-reports'));

const MULTI_JOB_APP = '<Amplify App reused by multiple apps>';
const ORPHAN = '<orphan>';
const UNKNOWN = '<unknown>';

type StackInfo = {
  stackName: string;
  stackStatus: string;
  resourcesFailedToDelete?: string[];
  tags: Record<string, string>;
  region: string;
  jobId: string;
  cbInfo?: CodeBuild.Build;
};

type AmplifyAppInfo = {
  appId: string;
  name: string;
  region: string;
  backends: Record<string, StackInfo>;
};

type S3BucketInfo = {
  name: string;
  jobId?: string;
  region: string;
  cbInfo?: CodeBuild.Build;
};

type IamRoleInfo = {
  name: string;
  cbInfo?: CodeBuild.Build;
};

type RdsInstanceInfo = {
  identifier: string;
  region: string;
};

type ReportEntry = {
  jobId?: string;
  buildBatchArn?: string;
  buildComplete?: boolean;
  cbJobDetails?: CodeBuild.Build;
  buildStatus?: string;
  amplifyApps: Record<string, AmplifyAppInfo>;
  stacks: Record<string, StackInfo>;
  buckets: Record<string, S3BucketInfo>;
  roles: Record<string, IamRoleInfo>;
  instances: Record<string, RdsInstanceInfo>;
};

type JobFilterPredicate = (job: ReportEntry) => boolean;

type CBJobInfo = {
  buildBatchArn: string;
  projectName: string;
  buildComplete: boolean;
  cbJobDetails: CodeBuild.Build;
  buildStatus: string;
};

type AWSAccountInfo = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

const BUCKET_TEST_REGEX = /test/;
const IAM_TEST_REGEX =
  /!RotateE2eAwsToken-e2eTestContextRole|-integtest$|^amplify-|^eu-|^us-|^ap-|^auth-exhaustive-tests|rds-schema-inspector-integtest|^amplify_e2e_tests_lambda|^JsonMockStack-jsonMockApi|^SubscriptionAuth|^cdkamplifytable[0-9]*-|^MutationConditionTest-|^SearchableAuth|^SubscriptionRTFTests-|^NonModelAuthV2FunctionTransformerTests-|^MultiAuthV2Transformer|^FunctionTransformerTests|-integtest-/;
const RDS_TEST_REGEX = /integtest/;
const STALE_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

const isCI = (): boolean => !!(process.env.CI && process.env.CODEBUILD);
/*
 * Exit on expired token as all future requests will fail.
 */
const handleExpiredTokenException = (): void => {
  console.log('Token expired. Exiting...');
  process.exit();
};

/**
 * We define a resource as viable for deletion if it matches TEST_REGEX in the name, and if it is > STALE_DURATION_MS old.
 */
const testBucketStalenessFilter = (resource: aws.S3.Bucket): boolean => {
  const isTestResource = resource.Name.match(BUCKET_TEST_REGEX);
  const isStaleResource = Date.now() - resource.CreationDate.getMilliseconds() > STALE_DURATION_MS;
  return isTestResource && isStaleResource;
};

const testRoleStalenessFilter = (resource: aws.IAM.Role): boolean => {
  const isTestResource = resource.RoleName.match(IAM_TEST_REGEX);
  const isStaleResource = Date.now() - resource.CreateDate.getMilliseconds() > STALE_DURATION_MS;
  return isTestResource && isStaleResource;
};

const testInstanceStalenessFilter = (resource: aws.RDS.DBInstance): boolean => {
  const isTestResource = resource.DBInstanceIdentifier.match(RDS_TEST_REGEX);
  const isStaleResource =
    resource.DBInstanceStatus == 'available' && Date.now() - resource.InstanceCreateTime.getMilliseconds() > STALE_DURATION_MS;
  return isTestResource && isStaleResource;
};

/**
 * Get all S3 buckets in the account, and filter down to the ones we consider stale.
 */
const getOrphanS3TestBuckets = async (account: AWSAccountInfo): Promise<S3BucketInfo[]> => {
  const s3Client = new aws.S3(getAWSConfig(account));
  const listBucketResponse = await s3Client.listBuckets().promise();
  const staleBuckets = listBucketResponse.Buckets.filter(testBucketStalenessFilter);

  const bucketInfos = await Promise.all(
    staleBuckets.map(async (staleBucket): Promise<S3BucketInfo> => {
      const region = await getBucketRegion(account, staleBucket.Name);
      return {
        name: staleBucket.Name,
        region,
      };
    }),
  );
  return bucketInfos;
};

/**
 * Get all iam roles in the account, and filter down to the ones we consider stale.
 */
const getOrphanTestIamRoles = async (account: AWSAccountInfo): Promise<IamRoleInfo[]> => {
  const iamClient = new aws.IAM(getAWSConfig(account));
  const listRoleResponse = await iamClient.listRoles({ MaxItems: 1000 }).promise();
  const staleRoles = listRoleResponse.Roles.filter(testRoleStalenessFilter);
  return staleRoles.map((it) => ({ name: it.RoleName }));
};

/**
 * Get all RDS instances in the account, and filter down to the ones we consider stale.
 */
const getOrphanRdsInstances = async (account: AWSAccountInfo, region: string): Promise<RdsInstanceInfo[]> => {
  try {
    const rdsClient = new aws.RDS(getAWSConfig(account, region));
    const listRdsInstanceResponse = await rdsClient.describeDBInstances().promise();
    const staleInstances = listRdsInstanceResponse.DBInstances.filter(testInstanceStalenessFilter);
    return staleInstances.map((i) => ({ identifier: i.DBInstanceIdentifier, region }));
  } catch (e) {
    if (e?.code === 'InvalidClientTokenId') {
      // Do not fail the cleanup and continue
      // This is due to either child account or parent account not available in that region
      console.log(`Listing RDS instances for account ${account.accountId}-${region} failed with error with code ${e?.code}. Skipping.`);
      return [];
    } else {
      throw e;
    }
  }
};

/**
 * Get the relevant AWS config object for a given account and region.
 */
const getAWSConfig = ({ accessKeyId, secretAccessKey, sessionToken }: AWSAccountInfo, region?: string): unknown => ({
  credentials: {
    accessKeyId,
    secretAccessKey,
    sessionToken,
  },
  ...(region ? { region } : {}),
  maxRetries: 10,
});

/**
 * Returns a list of Amplify Apps in the region. The apps includes information about the CodeBuild that created the app
 * This is determined by looking at tags of the backend environments that are associated with the Apps
 * @param account aws account to query for amplify Apps
 * @param region aws region to query for amplify Apps
 * @returns Promise<AmplifyAppInfo[]> a list of Amplify Apps in the region with build info
 */
const getAmplifyApps = async (account: AWSAccountInfo, region: string): Promise<AmplifyAppInfo[]> => {
  const config = getAWSConfig(account, region);
  const amplifyClient = new aws.Amplify(config);
  const result: AmplifyAppInfo[] = [];
  let amplifyApps = { apps: [] };
  try {
    amplifyApps = await amplifyClient.listApps({ maxResults: 50 }).promise(); // keeping it to 50 as max supported is 50
  } catch (e) {
    if (e?.code === 'UnrecognizedClientException') {
      // Do not fail the cleanup and continue
      console.log(`Listing apps for account ${account.accountId}-${region} failed with error with code ${e?.code}. Skipping.`);
      return result;
    } else {
      throw e;
    }
  }

  for (const app of amplifyApps?.apps) {
    const backends: Record<string, StackInfo> = {};
    try {
      const backendEnvironments = await amplifyClient.listBackendEnvironments({ appId: app.appId, maxResults: 50 }).promise();
      for (const backendEnv of backendEnvironments.backendEnvironments) {
        const buildInfo = await getStackDetails(backendEnv.stackName, account, region);
        if (buildInfo) {
          backends[backendEnv.environmentName] = buildInfo;
        }
      }
    } catch (e) {
      console.log(e);
    }
    result.push({
      appId: app.appId,
      name: app.name,
      region,
      backends,
    });
  }
  return result;
};

/**
 * Return the CodeBuild job id looking at `codebuild:build_id` in the tags
 * @param tags Tags associated with the resource
 * @returns build number or undefined
 */
const getJobId = (tags: aws.CloudFormation.Tags = []): string | undefined => {
  const jobId = tags.find((tag) => tag.Key === 'codebuild:build_id')?.Value;
  return jobId;
};

/**
 * Gets detail about a stack including the details about CodeBuild job that created the stack. If a stack
 * has status of `DELETE_FAILED` then it also includes the list of physical id of resources that caused
 * deletion failures
 *
 * @param stackName name of the stack
 * @param account account
 * @param region region
 * @returns stack details
 */
const getStackDetails = async (stackName: string, account: AWSAccountInfo, region: string): Promise<StackInfo | void> => {
  const cfnClient = new aws.CloudFormation(getAWSConfig(account, region));
  const stack = await cfnClient.describeStacks({ StackName: stackName }).promise();
  const tags = stack.Stacks.length && stack.Stacks[0].Tags;
  const stackStatus = stack.Stacks[0].StackStatus;
  let resourcesFailedToDelete: string[] = [];
  if (stackStatus === 'DELETE_FAILED') {
    // TODO: We need to investigate if we should go ahead and remove the resources to prevent account getting cluttered
    const resources = await cfnClient.listStackResources({ StackName: stackName }).promise();
    resourcesFailedToDelete = resources.StackResourceSummaries.filter((r) => r.ResourceStatus === 'DELETE_FAILED').map(
      (r) => r.LogicalResourceId,
    );
  }
  const jobId = getJobId(tags);
  return {
    stackName,
    stackStatus,
    resourcesFailedToDelete,
    region,
    tags: tags.reduce((acc, tag) => ({ ...acc, [tag.Key]: tag.Value }), {}),
    jobId,
  };
};

const getStacks = async (account: AWSAccountInfo, region: string): Promise<StackInfo[]> => {
  const cfnClient = new aws.CloudFormation(getAWSConfig(account, region));
  const results: StackInfo[] = [];
  let stacks;
  try {
    stacks = await cfnClient
      .listStacks({
        StackStatusFilter: [
          'CREATE_COMPLETE',
          'ROLLBACK_FAILED',
          'DELETE_FAILED',
          'UPDATE_COMPLETE',
          'UPDATE_ROLLBACK_FAILED',
          'UPDATE_ROLLBACK_COMPLETE',
          'IMPORT_COMPLETE',
          'IMPORT_ROLLBACK_FAILED',
          'IMPORT_ROLLBACK_COMPLETE',
        ],
      })
      .promise();
  } catch (e) {
    if (e?.code === 'InvalidClientTokenId') {
      // Do not fail the cleanup and continue
      console.log(`Listing stacks for account ${account.accountId}-${region} failed with error with code ${e?.code}. Skipping.`);
      return results;
    } else {
      throw e;
    }
  }

  // We are interested in only the root stacks that are deployed by amplify-cli
  const rootStacks = stacks.StackSummaries.filter((stack) => !stack.RootId);
  for (const stack of rootStacks) {
    try {
      const details = await getStackDetails(stack.StackName, account, region);
      if (details) {
        results.push(details);
      }
    } catch {
      // don't want to barf and fail e2e tests
    }
  }
  return results;
};

const getCodeBuildClient = (): CodeBuild => {
  return new CodeBuild({
    apiVersion: '2016-10-06',
    region: 'us-east-1',
  });
};

const getJobCodeBuildDetails = async (jobIds: string[]): Promise<CodeBuild.Build[]> => {
  if (jobIds.length === 0) {
    return [];
  }
  const client = getCodeBuildClient();
  try {
    const { builds } = await client.batchGetBuilds({ ids: jobIds }).promise();
    return builds;
  } catch (e) {
    console.log(e);
  }
};

const getBucketRegion = async (account: AWSAccountInfo, bucketName: string): Promise<string> => {
  const awsConfig = getAWSConfig(account);
  const s3Client = new aws.S3(awsConfig);
  const location = await s3Client.getBucketLocation({ Bucket: bucketName }).promise();
  const region = location.LocationConstraint ?? 'us-east-1';
  return region;
};

const getS3Buckets = async (account: AWSAccountInfo): Promise<S3BucketInfo[]> => {
  const awsConfig = getAWSConfig(account);
  const s3Client = new aws.S3(awsConfig);
  const buckets = await s3Client.listBuckets().promise();
  const result: S3BucketInfo[] = [];
  for (const bucket of buckets.Buckets) {
    let region: string | undefined;
    try {
      region = await getBucketRegion(account, bucket.Name);
      // Operations on buckets created in opt-in regions appear to require region-specific clients
      const regionalizedClient = new aws.S3({
        region,
        ...(awsConfig as object),
      });
      const bucketDetails = await regionalizedClient.getBucketTagging({ Bucket: bucket.Name }).promise();
      const jobId = getJobId(bucketDetails.TagSet);
      if (jobId) {
        result.push({
          name: bucket.Name,
          jobId,
          region,
        });
      }
    } catch (e) {
      // TODO: Why do we process the bucket even with these particular errors?
      if (e.code === 'NoSuchTagSet' || e.code === 'NoSuchBucket') {
        result.push({
          name: bucket.Name,
          region: region ?? 'us-east-1',
        });
      } else if (e.code === 'InvalidToken') {
        // We see some buckets in some accounts that were somehow created in an opt-in region different from the one to which the account is
        // actually opted in. We don't quite know how this happened, but for now, we'll make a note of the inconsistency and continue
        // processing the rest of the buckets.
        console.error(`Skipping processing ${account.accountId}, bucket ${bucket.Name}`, e);
      } else {
        throw e;
      }
    }
  }
  return result;
};

/**
 * extract and moves CodeBuild job details
 */
const extractCCIJobInfo = (record: S3BucketInfo | StackInfo | AmplifyAppInfo, buildInfos: Record<string, CodeBuild.Build[]>): CBJobInfo => {
  const buildId = _.get(record, ['0', 'jobId']);
  return {
    buildBatchArn: _.get(buildInfos, [buildId, '0', 'buildBatchArn']),
    projectName: _.get(buildInfos, [buildId, '0', 'projectName']),
    buildComplete: _.get(buildInfos, [buildId, '0', 'buildComplete']),
    cbJobDetails: _.get(buildInfos, [buildId, '0']),
    buildStatus: _.get(buildInfos, [buildId, '0', 'buildStatus']),
  };
};

/**
 * Merges stale resources and returns a list grouped by the CodeBuild jobId. Amplify Apps that don't have
 * any backend environment are grouped as Orphan apps and apps that have Backend created by different CodeBuild jobs are
 * grouped as MULTI_JOB_APP. Any resource that do not have a CodeBuild job is grouped under UNKNOWN
 */
const mergeResourcesByCCIJob = async (
  amplifyApp: AmplifyAppInfo[],
  cfnStacks: StackInfo[],
  s3Buckets: S3BucketInfo[],
  orphanS3Buckets: S3BucketInfo[],
  orphanIamRoles: IamRoleInfo[],
  orphanRdsInstances: RdsInstanceInfo[],
): Promise<Record<string, ReportEntry>> => {
  const result: Record<string, ReportEntry> = {};

  const stacksByJobId = _.groupBy(cfnStacks, (stack: StackInfo) => _.get(stack, ['jobId'], UNKNOWN));

  const bucketByJobId = _.groupBy(s3Buckets, (bucketInfo: S3BucketInfo) => _.get(bucketInfo, ['jobId'], UNKNOWN));

  const amplifyAppByJobId = _.groupBy(amplifyApp, (appInfo: AmplifyAppInfo) => {
    if (Object.keys(appInfo.backends).length === 0) {
      return ORPHAN;
    }

    const buildIds = _.groupBy(appInfo.backends, (backendInfo) => _.get(backendInfo, ['jobId'], UNKNOWN));
    if (Object.keys(buildIds).length === 1) {
      return Object.keys(buildIds)[0];
    }

    return MULTI_JOB_APP;
  });
  const codeBuildJobIds: string[] = _.uniq([
    ...Object.keys(stacksByJobId),
    ...Object.keys(bucketByJobId),
    ...Object.keys(amplifyAppByJobId),
  ]).filter((jobId: string) => jobId !== UNKNOWN && jobId !== ORPHAN && jobId !== MULTI_JOB_APP);
  const buildInfos = await getJobCodeBuildDetails(codeBuildJobIds);
  const buildInfosByJobId = _.groupBy(buildInfos, (build: CodeBuild.Build) => _.get(build, ['id']));
  _.mergeWith(
    result,
    _.pickBy(amplifyAppByJobId, (__, key) => key !== MULTI_JOB_APP),
    (val, src, key) => ({
      ...val,
      ...extractCCIJobInfo(src, buildInfosByJobId),
      jobId: key,
      amplifyApps: src,
    }),
  );

  _.mergeWith(
    result,
    stacksByJobId,
    (__: unknown, key: string) => key !== ORPHAN,
    (val, src, key) => ({
      ...val,
      ...extractCCIJobInfo(src, buildInfosByJobId),
      jobId: key,
      stacks: src,
    }),
  );

  _.mergeWith(result, bucketByJobId, (val, src, key) => ({
    ...val,
    ...extractCCIJobInfo(src, buildInfosByJobId),
    jobId: key,
    buckets: src,
  }));

  const orphanBuckets = {
    [ORPHAN]: orphanS3Buckets,
  };

  _.mergeWith(result, orphanBuckets, (val, src, key) => ({
    ...val,
    jobId: key,
    buckets: src,
  }));

  const orphanIamRolesGroup = {
    [ORPHAN]: orphanIamRoles,
  };

  _.mergeWith(result, orphanIamRolesGroup, (val, src, key) => ({
    ...val,
    jobId: key,
    roles: src,
  }));

  const orphanRdsInstancesGroup = {
    [ORPHAN]: orphanRdsInstances,
  };

  _.mergeWith(result, orphanRdsInstancesGroup, (val, src, key) => ({
    ...val,
    jobId: key,
    instances: src,
  }));

  return result;
};

const deleteAmplifyApps = async (account: AWSAccountInfo, accountIndex: number, apps: AmplifyAppInfo[]): Promise<void> => {
  await Promise.all(apps.map((app) => deleteAmplifyApp(account, accountIndex, app)));
};

const deleteAmplifyApp = async (account: AWSAccountInfo, accountIndex: number, app: AmplifyAppInfo): Promise<void> => {
  const { name, appId, region } = app;
  console.log(`${generateAccountInfo(account, accountIndex)} Deleting App ${name}(${appId})`);
  const amplifyClient = new aws.Amplify(getAWSConfig(account, region));
  try {
    await amplifyClient.deleteApp({ appId }).promise();
  } catch (e) {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting Amplify App ${appId} failed with the following error`, e);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const deleteIamRoles = async (account: AWSAccountInfo, accountIndex: number, roles: IamRoleInfo[]): Promise<void> => {
  // Sending consecutive delete role requests is throwing Rate limit exceeded exception.
  // We introduce a brief delay between batches
  const batchSize = 20;
  for (let i = 0; i < roles.length; i += batchSize) {
    const rolesToDelete = roles.slice(i, i + batchSize);
    await Promise.all(rolesToDelete.map((role) => deleteIamRole(account, accountIndex, role)));
    await sleep(5000);
  }
};

const deleteIamRole = async (account: AWSAccountInfo, accountIndex: number, role: IamRoleInfo): Promise<void> => {
  const { name: roleName } = role;
  try {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting Iam Role ${roleName}`);
    const iamClient = new aws.IAM(getAWSConfig(account));
    await deleteAttachedRolePolicies(account, accountIndex, roleName);
    await deleteRolePolicies(account, accountIndex, roleName);
    await iamClient.deleteRole({ RoleName: roleName }).promise();
  } catch (e) {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting iam role ${roleName} failed with error ${e.message}`);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const deleteAttachedRolePolicies = async (account: AWSAccountInfo, accountIndex: number, roleName: string): Promise<void> => {
  const iamClient = new aws.IAM(getAWSConfig(account));
  const rolePolicies = await iamClient.listAttachedRolePolicies({ RoleName: roleName }).promise();
  await Promise.all(rolePolicies.AttachedPolicies.map((policy) => detachIamAttachedRolePolicy(account, accountIndex, roleName, policy)));
};

const detachIamAttachedRolePolicy = async (
  account: AWSAccountInfo,
  accountIndex: number,
  roleName: string,
  policy: aws.IAM.AttachedPolicy,
): Promise<void> => {
  try {
    console.log(`${generateAccountInfo(account, accountIndex)} Detach Iam Attached Role Policy ${policy.PolicyName}`);
    const iamClient = new aws.IAM(getAWSConfig(account));
    await iamClient.detachRolePolicy({ RoleName: roleName, PolicyArn: policy.PolicyArn }).promise();
  } catch (e) {
    console.log(`${generateAccountInfo(account, accountIndex)} Detach iam role policy ${policy.PolicyName} failed with error ${e.message}`);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const deleteRolePolicies = async (account: AWSAccountInfo, accountIndex: number, roleName: string): Promise<void> => {
  const iamClient = new aws.IAM(getAWSConfig(account));
  const rolePolicies = await iamClient.listRolePolicies({ RoleName: roleName }).promise();
  await Promise.all(rolePolicies.PolicyNames.map((policy) => deleteIamRolePolicy(account, accountIndex, roleName, policy)));
};

const deleteIamRolePolicy = async (account: AWSAccountInfo, accountIndex: number, roleName: string, policyName: string): Promise<void> => {
  try {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting Iam Role Policy ${policyName}`);
    const iamClient = new aws.IAM(getAWSConfig(account));
    await iamClient.deleteRolePolicy({ RoleName: roleName, PolicyName: policyName }).promise();
  } catch (e) {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting iam role policy ${policyName} failed with error ${e.message}`);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const deleteBuckets = async (account: AWSAccountInfo, accountIndex: number, buckets: S3BucketInfo[]): Promise<void> => {
  await Promise.all(buckets.map((bucket) => deleteBucket(account, accountIndex, bucket)));
};

const deleteBucket = async (account: AWSAccountInfo, accountIndex: number, bucket: S3BucketInfo): Promise<void> => {
  const { name } = bucket;
  try {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting S3 Bucket ${name}`);
    const awsConfig = getAWSConfig(account);
    const regionalizedS3Client = new aws.S3({
      region: bucket.region,
      ...(awsConfig as object),
    });
    await deleteS3Bucket(name, regionalizedS3Client);
  } catch (e) {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting bucket ${name} failed with error ${e.message}`);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const deleteRdsInstances = async (account: AWSAccountInfo, accountIndex: number, instances: RdsInstanceInfo[]): Promise<void> => {
  await Promise.all(instances.map((instance) => deleteRdsInstance(account, accountIndex, instance)));
};

const deleteRdsInstance = async (account: AWSAccountInfo, accountIndex: number, instance: RdsInstanceInfo): Promise<void> => {
  const { identifier, region } = instance;
  console.log(`${generateAccountInfo(account, accountIndex)} Deleting RDS instance ${identifier}`);
  try {
    const rdsClient = new aws.RDS(getAWSConfig(account, region));
    await rdsClient.deleteDBInstance({ DBInstanceIdentifier: identifier, SkipFinalSnapshot: true }).promise();
  } catch (e) {
    console.log(`${generateAccountInfo(account, accountIndex)} Deleting instance ${identifier} failed with error ${e.message}`);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const deleteCfnStacks = async (account: AWSAccountInfo, accountIndex: number, stacks: StackInfo[]): Promise<void> => {
  await Promise.all(stacks.map((stack) => deleteCfnStack(account, accountIndex, stack)));
};

const deleteCfnStack = async (account: AWSAccountInfo, accountIndex: number, stack: StackInfo): Promise<void> => {
  const { stackName, region, resourcesFailedToDelete } = stack;
  const resourceToRetain = resourcesFailedToDelete.length ? resourcesFailedToDelete : undefined;
  console.log(`${generateAccountInfo(account, accountIndex)} Deleting CloudFormation stack ${stackName}`);
  try {
    const cfnClient = new aws.CloudFormation(getAWSConfig(account, region));
    await cfnClient.deleteStack({ StackName: stackName, RetainResources: resourceToRetain }).promise();
    await cfnClient.waitFor('stackDeleteComplete', { StackName: stackName }).promise();
  } catch (e) {
    console.log(`Deleting CloudFormation stack ${stackName} failed with error ${e.message}`);
    if (e.code === 'ExpiredTokenException') {
      handleExpiredTokenException();
    }
  }
};

const generateReport = (jobs: _.Dictionary<ReportEntry>, accountIdx: number): void => {
  const reportPath = path.join(reportPathDir, `stale-resources-${accountIdx}.json`);
  fs.ensureFileSync(reportPath);
  fs.writeFileSync(reportPath, JSON.stringify(jobs, null, 4));
};

/**
 * While we basically fan-out deletes elsewhere in this script, leaving the app->cfn->bucket delete process
 * serial within a given account, it's not immediately clear if this is necessary, but seems possibly valuable.
 */
const deleteResources = async (
  account: AWSAccountInfo,
  accountIndex: number,
  staleResources: Record<string, ReportEntry>,
): Promise<void> => {
  for (const jobId of Object.keys(staleResources)) {
    const resources = staleResources[jobId];
    if (resources.amplifyApps) {
      await deleteAmplifyApps(account, accountIndex, Object.values(resources.amplifyApps));
    }

    if (resources.stacks) {
      await deleteCfnStacks(account, accountIndex, Object.values(resources.stacks));
    }

    if (resources.buckets) {
      await deleteBuckets(account, accountIndex, Object.values(resources.buckets));
    }

    if (resources.roles) {
      await deleteIamRoles(account, accountIndex, Object.values(resources.roles));
    }

    if (resources.instances) {
      await deleteRdsInstances(account, accountIndex, Object.values(resources.instances));
    }
  }
};

/**
 * Grab the right CodeBuild filter based on args passed in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getFilterPredicate = (args: any): JobFilterPredicate => {
  const filterByJobId = (jobId: string) => (job: ReportEntry) => job.jobId === jobId;
  const filterByBuildBatchArn = (buildBatchArn: string) => (job: ReportEntry) => job.buildBatchArn === buildBatchArn;
  const filterAllStaleResources = () => (job: ReportEntry) => job.buildComplete || job.jobId === ORPHAN;

  if (args._.length === 0) {
    return filterAllStaleResources();
  }
  if (args._[0] === 'buildBatchArn') {
    return filterByBuildBatchArn(args.buildBatchArn as string);
  }
  if (args._[0] === 'job') {
    return filterByJobId(args.jobId as string);
  }
  throw Error('Invalid args config');
};

/**
 * Retrieve the accounts to process for potential cleanup. By default we will attempt
 * to get all accounts within the root account organization.
 */
const getAccountsToCleanup = async (): Promise<AWSAccountInfo[]> => {
  // This script runs using the codebuild project role to begin with
  const stsClient = new aws.STS({
    apiVersion: '2011-06-15',
  });
  const assumeRoleResForE2EParent = await stsClient
    .assumeRole({
      RoleArn: process.env.TEST_ACCOUNT_ROLE,
      RoleSessionName: `testSession${Math.floor(Math.random() * 100000)}`,
      // One hour
      DurationSeconds: 1 * 60 * 60,
    })
    .promise();
  const e2eParentAccountCred = {
    accessKeyId: assumeRoleResForE2EParent.Credentials.AccessKeyId,
    secretAccessKey: assumeRoleResForE2EParent.Credentials.SecretAccessKey,
    sessionToken: assumeRoleResForE2EParent.Credentials.SessionToken,
  };
  const stsClientForE2E = new aws.STS({
    apiVersion: '2011-06-15',
    credentials: e2eParentAccountCred,
  });
  const parentAccountIdentity = await stsClientForE2E.getCallerIdentity().promise();
  const orgApi = new aws.Organizations({
    apiVersion: '2016-11-28',
    // the region where the organization exists
    region: 'us-east-1',
    credentials: e2eParentAccountCred,
  });
  try {
    const orgAccounts = await orgApi.listAccounts().promise();
    const accountCredentialPromises = orgAccounts.Accounts.map(async (account) => {
      if (account.Id === parentAccountIdentity.Account) {
        return {
          accountId: account.Id,
          ...e2eParentAccountCred,
        };
      }
      const randomNumber = Math.floor(Math.random() * 100000);
      const assumeRoleRes = await stsClientForE2E
        .assumeRole({
          RoleArn: `arn:aws:iam::${account.Id}:role/OrganizationAccountAccessRole`,
          RoleSessionName: `testSession${randomNumber}`,
          // One hour
          DurationSeconds: 1 * 60 * 60,
        })
        .promise();
      return {
        accountId: account.Id,
        accessKeyId: assumeRoleRes.Credentials.AccessKeyId,
        secretAccessKey: assumeRoleRes.Credentials.SecretAccessKey,
        sessionToken: assumeRoleRes.Credentials.SessionToken,
      };
    });
    return await Promise.all(accountCredentialPromises);
  } catch (e) {
    console.error(e);
    console.log(
      'Error assuming child account role. This could be because the script is already running from within a child account. Running on current AWS account only.',
    );
    return [
      {
        accountId: parentAccountIdentity.Account,
        ...e2eParentAccountCred,
      },
    ];
  }
};

const cleanupAccount = async (account: AWSAccountInfo, accountIndex: number, filterPredicate: JobFilterPredicate): Promise<void> => {
  const appPromises = testRegions.map((region) => getAmplifyApps(account, region));
  const stackPromises = testRegions.map((region) => getStacks(account, region));
  const bucketPromise = getS3Buckets(account);
  const orphanBucketPromise = getOrphanS3TestBuckets(account);
  const orphanIamRolesPromise = getOrphanTestIamRoles(account);
  const orphanRdsInstancesPromise = testRegions.map((region) => getOrphanRdsInstances(account, region));

  const apps = (await Promise.all(appPromises)).flat();
  const stacks = (await Promise.all(stackPromises)).flat();
  const buckets = await bucketPromise;
  const orphanBuckets = await orphanBucketPromise;
  const orphanIamRoles = await orphanIamRolesPromise;
  const orphanRdsInstances = (await Promise.all(orphanRdsInstancesPromise)).flat();

  const allResources = await mergeResourcesByCCIJob(apps, stacks, buckets, orphanBuckets, orphanIamRoles, orphanRdsInstances);
  const staleResources = _.pickBy(allResources, filterPredicate);

  generateReport(staleResources, accountIndex);
  await deleteResources(account, accountIndex, staleResources);
  console.log(`${generateAccountInfo(account, accountIndex)} Cleanup done!`);
};

const generateAccountInfo = (account: AWSAccountInfo, accountIndex: number): string => {
  return `[ACCOUNT ${accountIndex}][${account.accountId}]`;
};

/**
 * Execute the cleanup script.
 * Cleanup will happen in parallel across all accounts within a given organization,
 * based on the requested filter parameters (i.e. for a given workflow, job, or all stale resources).
 * Logs are emitted for given account ids anywhere we've fanned out, but we use an indexing scheme instead
 * of account ids since the logs these are written to will be effectively public.
 */
const cleanup = async (): Promise<void> => {
  const args = yargs
    .command('*', 'clean up all the stale resources')
    .command('buildBatchArn <build-batch-arn>', 'clean all the resources created by batch build', (_yargs) => {
      _yargs.positional('buildBatchArn', {
        describe: 'ARN of batch build',
        type: 'string',
        demandOption: '',
      });
    })
    .command('job <jobId>', 'clean all the resource created by a job', (_yargs) => {
      _yargs.positional('jobId', {
        describe: 'job id of the job',
        type: 'string',
      });
    })
    .help().argv;
  config();

  const filterPredicate = getFilterPredicate(args);
  const accounts = await getAccountsToCleanup();
  accounts.map((account, i) => {
    console.log(`${generateAccountInfo(account, i)} is under cleanup`);
  });
  await Promise.all(accounts.map((account, i) => cleanupAccount(account, i, filterPredicate)));
  console.log('Done cleaning all accounts!');
};

cleanup();
