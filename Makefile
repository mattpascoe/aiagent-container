.PHONY: build update run run-args clean purge shell setup usage help logs
.ONESHELL:

# Gather the current users real username and UID/GID so we can use it within the container
export REAL_USER := $(or $(SUDO_USER),$(shell whoami))
export HOST_UID := $(shell id -u $(REAL_USER))
export HOST_GID := $(shell id -g $(REAL_USER))
export COMPOSE_PROJECT_NAME := $(REAL_USER)

export PARANOID_MODE ?= true
export WORKDIR ?= .
export SVC ?= pi


usage:
	@cat <<EOF
	Usage: make [options] [target]
	
	Available targets:
	  build      Build docker container
	  update     Build a fresh container with no cache
	  run        Run the default pi context
	  run-args   Run the container with extra args (args="...")
	  shell      Start the container in bash
	  logs       Tail container logs
	  clean      Stop and remove containers
	  purge      Remove containers, images, and named volumes
	  usage      Show this help message
	
	Common options:
	  SVC=claude		The composer service to run (default: pi)
	  WORKDIR=/some/path	The workspace dir to mount into the container (default: .)
	
	Examples:
	  make SVC=claude WORKDIR=/opt/dev/username run

	EOF

help: usage

setup:
	@echo "\033[32mExecuting '\033[34m$(SVC)\033[32m' setup in workspace: \033[34m$(WORKDIR)\033[0m"
	@mkdir -p ~/.$(SVC)
	@chmod 755 ~/.$(SVC)
	@chown -R $$HOST_UID:$$HOST_GID ~/.$(SVC)

build: setup
	docker compose build $(SVC)

update: setup
	docker compose build --no-cache $(SVC)

run: setup
	docker compose run --service-ports --rm $(SVC)

run-args: setup
	docker compose run --service-ports --rm $(SVC) $(args)

shell: setup
	docker compose run --service-ports --rm --entrypoint /bin/bash $(SVC)

logs:
	docker compose logs --tail=100 -f $(SVC)

clean:
	docker compose down $(SVC)

#purge: clean
#	docker compose down --rmi local --volumes
