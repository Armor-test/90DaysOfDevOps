def notify(status,job_name,build_number,branch,armoecode_env,color) {
    slackSend channel: "#builds",
            color: "${color}",
            message: "Job ${status}. Job Name: ${job_name}, Build Number: ${build_number}, branch: ${branch}, Env: ${armoecode_env}",
            tokenCredentialId: 'slack-token'
    teamDomain: 'armorcode'
}

def notifier
pipeline {
    agent {
        ecs {
                inheritFrom 'devops-automation-agent-ec2'
                image '700709168703.dkr.ecr.us-west-2.amazonaws.com/devops-automation-agent/common:latest'
            }
    }

    options {
        timeout(time: 40, unit: 'MINUTES')
        ansiColor('xterm')
    }

    environment {
            CURRENT_PHASE = 'build'
        CLIENT_NAME = 'us'
        GIT_CREDENTIALS = 'Github'
        SOURCE_REPO = 'git@github.com:armor-code/armorcode-mcp-server.git'
    }

    parameters {
        string(name: 'ENV', defaultValue: 'preprod', description: 'Environment to deploy the MCP server')
        string(name: 'REGION', defaultValue: 'us-west-2', description: 'AWS region to deploy the Infrastructure')
        string(name: 'BRANCH', defaultValue: 'release', description: 'Git branch to build from')
    }

    stages {
        stage('Notify') {
            steps{
                notify("Started","${JOB_NAME}","${BUILD_NUMBER}","${BRANCH}","${ENV}","#FFFF00")
            }
        }

        stage('Clone Repository') {
            steps {
                script {
                    notifier = load 'shared/notifications.groovy'
                    // Clean up before cloning
                    sh "rm -rf armorcode-mcp-server"

                    dir('armorcode-mcp-server') {
                        git credentialsId: env.GIT_CREDENTIALS,
                            branch: params.BRANCH,
                            url: env.SOURCE_REPO
                    }
                }
            }
        }

        stage('Setup Build Environment') {
            steps {
                dir('armorcode-mcp-server') {
                    sh """
                        echo "Setting up multi-arch build environment..."

                        # Login to ECR
                        aws ecr get-login-password --region ${params.REGION} | docker login --username AWS --password-stdin 700709168703.dkr.ecr.${params.REGION}.amazonaws.com

                        # Install buildx if not available
                        if ! docker buildx version 2>/dev/null; then
                            echo "Installing Docker Buildx..."
                            BUILDX_VERSION=v0.12.0
                            mkdir -p ~/.docker/cli-plugins
                            ARCH=\$(uname -m)
                            case \${ARCH} in
                                x86_64) BUILDX_ARCH="linux-amd64" ;;
                                aarch64|arm64) BUILDX_ARCH="linux-arm64" ;;
                            esac
                            curl -sSLo ~/.docker/cli-plugins/docker-buildx \
                                "https://github.com/docker/buildx/releases/download/\${BUILDX_VERSION}/buildx-\${BUILDX_VERSION}.\${BUILDX_ARCH}"
                            chmod +x ~/.docker/cli-plugins/docker-buildx
                        fi

                        # Setup QEMU for multi-platform builds
                        docker run --rm --privileged 700709168703.dkr.ecr.us-west-2.amazonaws.com/tonistiigi/binfmt:latest --install all

                        # Setup buildx
                        docker buildx create --name multiarch --driver docker-container --use 2>/dev/null || docker buildx use multiarch
                        docker buildx inspect --bootstrap
                    """
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                dir('armorcode-mcp-server') {
                    sh """
                        echo "Building MCP Server Docker image..."

                        # Build amd64 image locally for scanning (--load only supports single platform)
                        docker buildx build --platform linux/amd64 \
                            --no-cache \
                            -t 700709168703.dkr.ecr.${params.REGION}.amazonaws.com/${params.ENV}-armorcode-mcp-server:latest \
                            --load .

                        echo "Image built locally for scanning"
                    """
                }
            }
        }

        stage('Scan Image for Vulnerabilities') {
            when {
                environment name: 'ENABLE_TRIVY_SCAN', value: 'true'
            }
            steps {
                sh """
                    echo "Scanning Image for Vulnerabilities..."
                    trivy --version

                    # Scan for CRITICAL vulnerabilities and save results
                    trivy image --format json -o scan_results.json --severity CRITICAL 700709168703.dkr.ecr.${params.REGION}.amazonaws.com/${params.ENV}-armorcode-mcp-server:latest
                    cat scan_results.json

                    echo "Checking vulnerability count..."
                    jq '.Results[].Vulnerabilities | length' scan_results.json | awk '{s+=\$1} END {print s}' > vuln_count.txt || echo "0" > vuln_count.txt

                    echo "Found \$(cat vuln_count.txt) vulnerabilities"
                """
            }
        }

        stage('Proceed with Vulnerabilities?') {
            when {
                environment name: 'ENABLE_TRIVY_SCAN', value: 'true'
                expression {
                    def vulnCount = sh(script: "cat vuln_count.txt", returnStdout: true).trim()
                    return vulnCount.isInteger() && vulnCount.toInteger() > 0
                }
            }
            steps {
                sh '''
                echo "vulnerabilities found!"
                '''
                timeout(time: 5, unit: 'MINUTES') { // Timeout after 5 minutes
                    input message: "vulnerabilities found! Do you want to proceed with pushing the image?",
                        ok: "Proceed with vulnerability"
                }
            }
        }

        stage('Push Multi-arch Image to ECR') {
            steps {
                dir('armorcode-mcp-server') {
                    sh """
                        echo "Building and pushing multi-architecture image to ECR..."

                        # Build and push multi-architecture image (amd64 and arm64) after scan approval
                        docker buildx build --no-cache --platform linux/amd64,linux/arm64 \
                            -t 700709168703.dkr.ecr.${params.REGION}.amazonaws.com/${params.ENV}-armorcode-mcp-server:latest \
                            --push .

                        echo "Multi-architecture image pushed to ECR with tag :latest"

                        # Cleanup local images
                        docker image rm 700709168703.dkr.ecr.${params.REGION}.amazonaws.com/${params.ENV}-armorcode-mcp-server:latest || true
                    """
                }
            }
        }

        stage('Deploy to ECS Service') {
            steps {
                script { env.CURRENT_PHASE = 'deploy' }
                sh """
                    echo "Deploying to ECS service with force new deployment..."
                    if aws ecs update-service --cluster ${params.ENV}-octo --service ${params.ENV}-mcp-server --force-new-deployment --region ${params.REGION} > /dev/null 2>&1; then
                        echo "ECS service ${params.ENV}-mcp-server updated successfully."
                    else
                        echo "Error: Failed to update ECS service."
                        exit 1
                    fi
                """
            }
        }

        stage('Wait for Deployment') {
            steps {
                sh """
                    echo "Waiting for deployment to complete..."
                    aws ecs wait services-stable --cluster ${params.ENV}-octo --services ${params.ENV}-mcp-server --region ${params.REGION}
                    echo "Deployment completed successfully!"
                """
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
                if (env.CURRENT_PHASE == 'deploy') {
                    notifier.deployFailure("${JOB_NAME}", "${BUILD_NUMBER}", "${BRANCH}", "${ENV}")
                } else {
                    notifier.buildFailure("${JOB_NAME}", "${BUILD_NUMBER}", "${BRANCH}", "${ENV}", '.')
                }
            }
        }

        always {
            sh '''
            # Clean Docker resources
            docker image prune -a -f || true
            docker system prune -f --volumes || true
            '''
        }

        cleanup {
            deleteDir()
        }
    }
}
