import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipeline_actions from '@aws-cdk/aws-codepipeline-actions';
import * as events from '@aws-cdk/aws-events';
import * as iam from '@aws-cdk/aws-iam';
import { Construct, Lazy } from '@aws-cdk/core';

/**
 * Type of the asset that is being published
 */
export enum AssetType {
  /**
   * A file
   */
  FILE = 'file',

  /**
   * A Docker image
   */
  DOCKER_IMAGE = 'docker-image',
}

/**
 * Props for a PublishAssetsAction
 */
export interface PublishAssetsActionProps {
  /**
   * Name of publishing action
   */
  readonly actionName: string;

  /**
   * The CodePipeline artifact that holds the Cloud Assembly.
   */
  readonly cloudAssemblyInput: codepipeline.Artifact;

  /**
   * AssetType we're publishing
   */
  readonly assetType: AssetType;

  /**
   * Version of CDK CLI to 'npm install'.
   *
   * @default - Latest version
   */
  readonly cdkCliVersion?: string;

  /**
   * Name of the CodeBuild project
   *
   * @default - Automatically generated
   */
  readonly projectName?: string;

  /**
   * Role to use for CodePipeline and CodeBuild to build and publish the assets.
   *
   * @default - Automatically generated
   */
  readonly role?: iam.IRole;
}

/**
 * Action to publish an asset in the pipeline
 *
 * Creates a CodeBuild project which will use the CDK CLI
 * to prepare and publish the asset.
 *
 * You do not need to instantiate this action -- it will automatically
 * be added by the pipeline when you add stacks that use assets.
 */
export class PublishAssetsAction extends Construct implements codepipeline.IAction {
  private readonly action: codepipeline.IAction;
  private readonly commands = new Array<string>();

  constructor(scope: Construct, id: string, private readonly props: PublishAssetsActionProps) {
    super(scope, id);

    const installSuffix = props.cdkCliVersion ? `@${props.cdkCliVersion}` : '';

    const project = new codebuild.PipelineProject(this, 'Default', {
      projectName: this.props.projectName,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: `npm install -g cdk-assets${installSuffix}`,
          },
          build: {
            commands: Lazy.listValue({ produce: () => this.commands }),
          },
        },
      }),
      // Needed to perform Docker builds
      environment: props.assetType === AssetType.DOCKER_IMAGE ? { privileged: true } : undefined,
      role: props.role,
    });

    const rolePattern = props.assetType === AssetType.DOCKER_IMAGE
      ? 'arn:*:iam::*:role/*-image-publishing-role-*'
      : 'arn:*:iam::*:role/*-file-publishing-role-*';

    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [rolePattern],
    }));

    this.action = new codepipeline_actions.CodeBuildAction({
      actionName: props.actionName,
      project,
      input: this.props.cloudAssemblyInput,
      role: props.role,
    });
  }

  /**
   * Add a single publishing command
   *
   * Manifest path should be relative to the root Cloud Assembly.
   */
  public addPublishCommand(relativeManifestPath: string, assetSelector: string) {
    const command = `cdk-assets --path "${relativeManifestPath}" --verbose publish "${assetSelector}"`;
    if (!this.commands.includes(command)) {
      this.commands.push(command);
    }
  }

  /**
   * Exists to implement IAction
   */
  public bind(scope: Construct, stage: codepipeline.IStage, options: codepipeline.ActionBindOptions):
  codepipeline.ActionConfig {
    return this.action.bind(scope, stage, options);
  }

  /**
   * Exists to implement IAction
   */
  public onStateChange(name: string, target?: events.IRuleTarget, options?: events.RuleProps): events.Rule {
    return this.action.onStateChange(name, target, options);
  }

  /**
   * Exists to implement IAction
   */
  public get actionProperties(): codepipeline.ActionProperties {
    // FIXME: I have had to make this class a Construct, because:
    //
    // - It needs access to the Construct tree, because it is going to add a `PipelineProject`.
    // - I would have liked to have done that in bind(), however,
    // - `actionProperties` (this method) is called BEFORE bind() is called, and by that point I
    //   don't have the "inner" Action yet to forward the call to.
    //
    // I've therefore had to construct the inner CodeBuildAction in the constructor, which requires making this
    // Action a Construct.
    //
    // Combined with how non-intuitive it is to make the "StackDeployAction", I feel there is something
    // wrong with the Action abstraction here.
    return this.action.actionProperties;
  }
}
