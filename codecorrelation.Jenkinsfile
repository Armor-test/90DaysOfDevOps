def notify(status,job_name,build_number,branch,armoecode_env,color) {
    slackSend channel: "#builds",
            color: "${color}",
            message: "Job ${status}. Job Name: ${job_name}, Build Number: ${build_number}, branch: ${branch}, Env: ${armoecode_env}",
            tokenCredentialId: 'slack-token'
    teamDomain: 'armorcode'
}
pipeline {
        agent {
            label 'ec2-agent'
        }
        options {
            timeout(time: 40, unit: 'MINUTES')
            ansiColor('xterm')
        }  
        parameters {
            string(name: 'ENV', defaultValue: 'dev', description: 'Environment to deploy the Armorcode infrastructure')
            string(name: 'PROFILE', defaultValue: 'dev', description: 'Profile to deploy the backend')
            string(name: 'REGION', defaultValue: 'us-west-2', description: 'AWS region to deploy the Infrastructure')
            string(name: 'AMINAME', defaultValue: 'armorcode-golden-ami-1705149121', description: 'use in terraform')
            string(name: 'JIRATICKET_NO', defaultValue: '', description: 'Optional JIRA ticket number')
            string(name: 'RELEASE_VERSION', defaultValue: '', description: 'Optional release version')
            string(name: 'BRANCH', defaultValue: 'dev', description: 'select branch/tag for octo deployment')
        }
        stages {
            stage('Notify') {
                steps{
                    notify("Started","${JOB_NAME}","${BUILD_NUMBER}","${BRANCH}","${ENV}","#FFFF00")
                }
                }
            }
            stage('Clone') {

                steps {
                    dir('octo') {

                        git credentialsId: 'Github',
                            branch: params.BRANCH,
                            url:  'git@github.com:armor-code/octo.git'
                    }
                }
            }

            stage('Build & Push Image to registry') {
                steps {
                    sh '''
                    pwd
                    cd \${WORKSPACE}/octo/Correlation/release/
                    aws ecr get-login-password --region \${REGION} | docker login --username AWS --password-stdin 700709168703.dkr.ecr.\${REGION}.amazonaws.com
                    docker pull 700709168703.dkr.ecr.\${REGION}.amazonaws.com/services/ubuntugolden:latest

                    aws ecr get-login-password --region \${REGION} | docker login --username AWS --password-stdin 034025401910.dkr.ecr.\${REGION}.amazonaws.com

                    # Setup QEMU for multi-platform builds (034025401910.dkr.ecr.us-west-2.amazonaws.com/tonistiigi/binfmt:latest works on both AMD64 and ARM64)
                    docker run --rm --privileged 034025401910.dkr.ecr.us-west-2.amazonaws.com/tonistiigi/binfmt:latest --install all

                    # One-time buildx setup with docker-container driver (creates if not exists, uses if exists)
                    docker buildx create --name multiarch --driver docker-container --use 2>/dev/null || docker buildx use multiarch
                    docker buildx inspect --bootstrap

                    # Single command to build and push BOTH architectures (amd64 and arm64)
                    docker buildx build --platform linux/amd64,linux/arm64 \
                        -t 034025401910.dkr.ecr.\${REGION}.amazonaws.com/dev-code-correlation:${BUILD_NUMBER} \
                        --push .

                    echo "Multi-architecture image pushed to ECR"
                    docker image rm 700709168703.dkr.ecr.\${REGION}.amazonaws.com/services/ubuntugolden:latest
                    '''
                }
            }
            stage('Scan Image for Vulnerabilities') {
                when {
                    environment name: 'ENABLE_TRIVY_SCAN', value: 'true'
                }
                steps {
                    
                        sh '''
                        # Checking Trivy is installed
                        curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b ~/.local/bin
                        export PATH="$HOME/.local/bin:$PATH"
                        trivy --version

                        # Scan for CRITICAL vulnerabilities and save results
                        echo "Scanning Image for Vulnerabilities..."
                        trivy image --format json -o scan_results.json --severity CRITICAL 034025401910.dkr.ecr.\${REGION}.amazonaws.com/dev-code-correlation:${BUILD_NUMBER}
                        cat scan_results.json
                        
                        echo "Checking vulnerability count..."
                        jq '.Results[].Vulnerabilities | length' scan_results.json | awk '{s+=$1} END {print s}' > vuln_count.txt || echo "0" > vuln_count.txt

                        echo "Found $(cat vuln_count.txt) vulnerabilities"

                        '''
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

                    #trivy image

                    '''
                    timeout(time: 5, unit: 'MINUTES') { // Timeout after 5 minutes
                        input message: "vulnerabilities found! Do you want to proceed with pushing the image?",
                            ok: "Proceed with vulnerability"
                    }
                    
                }
            }
            stage('Deploy Application on ECS') {
                steps {   
                    sh '''                    
                    TASK_DEFINITION=$(aws ecs describe-task-definition --task-definition dev-code-correlation-task --include TAGS --region \${REGION})
                    NEW_TASK_DEFINTIION=$(echo $TASK_DEFINITION | jq --arg IMAGE 034025401910.dkr.ecr.\${REGION}.amazonaws.com/dev-code-correlation:${BUILD_NUMBER} '.taskDefinition | .containerDefinitions[0].image = $IMAGE | del(.taskDefinitionArn) | del(.revision) | del(.status) | del(.requiresAttributes)|del(.registeredAt)|del(.registeredBy) | del(.compatibilities)') 
                    # Add the existing tags from the original task definition
                    NEW_TASK_DEFINTIION=$(echo $TASK_DEFINITION | jq --argjson taskDef "$NEW_TASK_DEFINTIION" 'if .tags != null then $taskDef + {tags: .tags} else $taskDef end')
                    aws ecs register-task-definition --region "\$REGION" --cli-input-json "$NEW_TASK_DEFINTIION"   
                    '''
                }
            }

            stage('Trigger Force New Deployment') {
                steps {
                    sh '''
                    echo "force update correlation ECS service"
                    LATEST_TASK_DEFINITION=$(aws ecs describe-task-definition --task-definition dev-code-correlation-task --query "taskDefinition.taskDefinitionArn" --output text --region \${REGION})
                    if aws ecs update-service --cluster \${ENV}-octo --service \${ENV}-ecs-jobs-common --task-definition $LATEST_TASK_DEFINITION --force-new-deployment --region \${REGION} > /dev/null 2>&1; then
                        echo "ECS service \${ENV}-ecs-jobs-common updated successfully."
                    else
                        echo "Error: Failed to update ECS service."
                        exit 1
                    fi
                    '''
                }
            }
        }
    post {
        success {
            notify("Completed","${JOB_NAME}","${BUILD_NUMBER}","${params.BRANCH}","${ENV}","good")
        }
        always {
            sh '''
            # Clean Docker resources
            docker image prune -a -f || true
            docker system prune -f --volumes || true
            '''
            deleteDir()
        }
    }
}