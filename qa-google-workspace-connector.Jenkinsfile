import groovy.transform.Field

@Field String DEFAULT_REPO_URL = 'git@github.com:armor-code/armorcode-ops-utils.git'

@Field Map SERVICE_CONFIG = [
    'google-workspace-connector': [
        dockerfile: 'google-workspace-connector/Dockerfile',
        ecrRepoName: 'google-workspace-connector',
        taskDefinitions: ['qa-google-workspace-connector-task'],
        ecsServices: [],  // JFC-triggered task — no ECS service to update
        tagWithBuildNumber: true
    ]
]

def notify(status, job_name, build_number, branch, armorcode_env, color) {
    slackSend channel: "#builds",
            color: "${color}",
            message: "Job ${status}. Job Name: ${job_name}, Build Number: ${build_number}, branch: ${branch}, Env: ${armorcode_env}",
            tokenCredentialId: 'slack-token',
            teamDomain: 'armorcode'
}

def getServiceConfig(serviceName) {
    def config = SERVICE_CONFIG[serviceName]
    if (!config) {
        error "Unknown service: ${serviceName}. Available services: ${SERVICE_CONFIG.keySet().join(', ')}"
    }
    return [
        dockerfile: config.dockerfile,
        repoUrl: config.repoUrl ?: DEFAULT_REPO_URL,
        ecrRepoName: config.ecrRepoName ?: serviceName,
        workDir: config.workDir ?: '',
        tagWithBuildNumber: config.tagWithBuildNumber ?: false,
        taskDefinitions: config.taskDefinitions ?: [],
        ecsServices: config.ecsServices ?: []
    ]
}

def buildDockerImage(config, envName, region, push = false) {
    def workDirCmd = config.workDir ? "cd ${config.workDir}" : "cd \${WORKSPACE}"
    def platforms = push ? 'linux/amd64,linux/arm64' : 'linux/arm64'
    def pushFlag = push ? '--push' : '--load'
    def imageTag = "034025401910.dkr.ecr.${region}.amazonaws.com/${envName}-${config.ecrRepoName}:latest"
    def buildNumberTagFlag = config.tagWithBuildNumber ? "-t 034025401910.dkr.ecr.${region}.amazonaws.com/${envName}-${config.ecrRepoName}:${env.BUILD_NUMBER}" : ''
    def baseImage = "034025401910.dkr.ecr.us-west-2.amazonaws.com/services/ubuntugolden"

    sh """
        ${workDirCmd}
        echo "Building image with platforms: ${platforms}"
        docker buildx build --platform ${platforms} \\
            --build-arg BASE_IMAGE=${baseImage} \\
            -t ${imageTag} \\
            ${buildNumberTagFlag} \\
            -f ${config.dockerfile} \\
            ${pushFlag} .
    """
    return imageTag
}

def notifier
pipeline {
    agent {
        label 'ec2-agent'
    }
    options {
        ansiColor('xterm')
    }
    parameters {
        string(name: 'ENV', defaultValue: 'qa', description: 'Environment')
        string(name: 'REGION', defaultValue: 'us-west-2', description: 'AWS region to deploy the Infrastructure')
        string(name: 'BRANCH', defaultValue: 'qa', description: 'Branch to build')
        choice(name: 'ECR_REPO_NAME', choices: ['google-workspace-connector'], description: 'Select the ECR repo')
    }

    environment {
        ECR_REGISTRY = '034025401910.dkr.ecr.us-west-2.amazonaws.com'
    }

    stages {
        stage('Initialize') {
            steps {
                script {
                    notifier = load 'shared/notifications.groovy'
                    def config = getServiceConfig(params.ECR_REPO_NAME)
                    env.SERVICE_DOCKERFILE = config.dockerfile
                    env.SERVICE_REPO_URL = config.repoUrl
                    env.SERVICE_ECR_REPO_NAME = config.ecrRepoName
                    env.SERVICE_WORK_DIR = config.workDir
                    env.IMAGE_TAG = "${ECR_REGISTRY}/${params.ENV}-${config.ecrRepoName}:latest"
                }
                notify("Started", "${JOB_NAME}", "${BUILD_NUMBER}", "${params.BRANCH}", "${params.ENV}", "#FFFF00")
            }
        }

        stage('Clone') {
            steps {
                checkout([$class: 'GitSCM',
                    branches: [[name: "${params.BRANCH}"]],
                    doGenerateSubmoduleConfigurations: false,
                    extensions: [],
                    gitTool: 'Default',
                    submoduleCfg: [],
                    userRemoteConfigs: [[credentialsId: 'Github', url: env.SERVICE_REPO_URL]]
                ])
                script {
                    notifier.captureCommitEmail('.', 'armorcode-ops-utils')
                }
            }
        }

        stage('Fetch Commit ID') {
            steps {
                script {
                    env.COMMIT_ID = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    writeFile file: "${env.WORKSPACE}/commit_id.txt", text: env.COMMIT_ID
                    echo "Commit ID: ${env.COMMIT_ID}, written to ${env.WORKSPACE}/commit_id.txt"
                }
            }
        }

        stage('Check ECR Repository') {
            steps {
                sh '''
                if aws ecr describe-repositories --repository-names ${ENV}-${SERVICE_ECR_REPO_NAME} --region ${REGION} 2>/dev/null; then
                    echo "${ENV}-${SERVICE_ECR_REPO_NAME} already exists."
                else
                    echo "Creating ${ENV}-${SERVICE_ECR_REPO_NAME} ECR"
                    aws ecr create-repository --repository-name ${ENV}-${SERVICE_ECR_REPO_NAME} --region ${REGION} --output json
                    echo "${ENV}-${SERVICE_ECR_REPO_NAME} created."
                fi
                '''
            }
        }

        stage('Setup Build Environment') {
            steps {
                sh '''
                aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}
                echo "Installing QEMU/binfmt for multi-arch builds..."
                docker run --rm --privileged 034025401910.dkr.ecr.us-west-2.amazonaws.com/tonistiigi/binfmt:latest --install all
                echo "Setting up Docker Buildx builder..."
                docker buildx create --name multiarch --driver docker-container --use 2>/dev/null || docker buildx use multiarch
                docker buildx inspect --bootstrap
                '''
            }
        }

        stage('Ensure Base Image in ECR') {
            steps {
                sh '''
                if ! aws ecr describe-repositories --repository-name python-base --region ${REGION} 2>/dev/null; then
                    echo "Creating python-base ECR repository"
                    aws ecr create-repository --repository-name python-base --region ${REGION} --output json
                fi
                if ! aws ecr describe-images --repository-name python-base --image-ids imageTag=3.11-slim --region ${REGION} 2>/dev/null; then
                    echo "python-base:3.11-slim not found in ECR, pushing from Docker Hub..."
                    docker buildx imagetools create \
                        --tag ${ECR_REGISTRY}/python-base:3.11-slim \
                        docker.io/library/python:3.11-slim
                    echo "python-base:3.11-slim pushed to ECR"
                else
                    echo "python-base:3.11-slim already exists in ECR"
                fi
                '''
            }
        }

        // stage('Build Image') {
        //     steps {
        //         script {
        //             def config = getServiceConfig(params.ECR_REPO_NAME)
        //             buildDockerImage(config, params.ENV, params.REGION, false)
        //         }
        //     }
        // }

        // stage('Scan Image for Vulnerabilities') {
        //     steps {
        //         sh '''
        //         curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b ~/.local/bin
        //         export PATH="$HOME/.local/bin:$PATH"
        //         trivy --version
        //         echo "Scanning Image for Vulnerabilities..."
        //         trivy image --format json -o scan_results.json --severity CRITICAL ${IMAGE_TAG}
        //         cat scan_results.json
        //         echo "Checking vulnerability count..."
        //         jq '.Results[].Vulnerabilities | length' scan_results.json | awk '{s+=$1} END {print s}' > vuln_count.txt || echo "0" > vuln_count.txt
        //         echo "Found $(cat vuln_count.txt) vulnerabilities"
        //         '''
        //     }
        // }

        // stage('Proceed with Vulnerabilities?') {
        //     when {
        //         expression {
        //             def vulnCount = sh(script: "cat vuln_count.txt", returnStdout: true).trim()
        //             return vulnCount.isInteger() && vulnCount.toInteger() > 0
        //         }
        //     }
        //     steps {
        //         sh 'echo "Vulnerabilities found!"'
        //         timeout(time: 5, unit: 'MINUTES') {
        //             input message: "Vulnerabilities found! Do you want to proceed with pushing the image?",
        //                 ok: "Proceed with vulnerability"
        //         }
        //     }
        // }

        stage('Push Multi-arch Image to Registry') {
            steps {
                script {
                    def config = getServiceConfig(params.ECR_REPO_NAME)
                    buildDockerImage(config, params.ENV, params.REGION, true)
                    echo "Multi-architecture image pushed to ECR"
                }
                sh '''
                docker image rm ${IMAGE_TAG} || true
                '''
            }
        }

        stage('Update ECS Task Definition') {
            steps {
                script {
                    def config = getServiceConfig(params.ECR_REPO_NAME)
                    def imageUri = "${ECR_REGISTRY}/${params.ENV}-${config.ecrRepoName}:${env.BUILD_NUMBER}"
                    config.taskDefinitions.each { taskDefName ->
                        echo "Updating task definition: ${taskDefName}"
                        sh """
                        TASK_DEFINITION=\$(aws ecs describe-task-definition --task-definition ${taskDefName} --include TAGS --region ${params.REGION})
                        NEW_TASK_DEFINITION=\$(echo \$TASK_DEFINITION | jq --arg IMAGE ${imageUri} '.taskDefinition | .containerDefinitions[0].image = \$IMAGE | del(.taskDefinitionArn) | del(.revision) | del(.status) | del(.requiresAttributes) | del(.registeredAt) | del(.registeredBy) | del(.compatibilities)')
                        NEW_TASK_DEFINITION=\$(echo \$TASK_DEFINITION | jq --argjson taskDef "\$NEW_TASK_DEFINITION" 'if .tags != null then \$taskDef + {tags: .tags} else \$taskDef end')
                        aws ecs register-task-definition --region "${params.REGION}" --cli-input-json "\$NEW_TASK_DEFINITION"
                        """
                    }
                }
            }
        }
    }

    post {
                success {
            script {
                if (notifier == null) { notifier = load 'shared/notifications.groovy' }
                notifier.success("${JOB_NAME}", "${BUILD_NUMBER}", "${BRANCH}", "${ENV}")
            }
        }
                failure {
            script {
                if (notifier == null) { notifier = load 'shared/notifications.groovy' }
                notifier.buildFailure("${JOB_NAME}", "${BUILD_NUMBER}", "${BRANCH}", "${ENV}", '.')
            }
        }
        always {
            sh '''
            docker image prune -a -f || true
            docker system prune -f --volumes || true
            '''
            deleteDir()
        }
    }
}
