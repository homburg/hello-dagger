import { connect } from "@dagger.io/dagger";

connect(
  async (client) => {
    // create a cache volume
    const nodeCache = client.cacheVolume("node");

    const platform = await client.defaultPlatform();

    const arch = platform.includes("arm64") ? "arm64" : "x64";

    const worker = client
      .container()
      .from("ubuntu")
      .withWorkdir("/wrk")
      .withExec([
        "sh",
        "-c",
        "apt-get update && apt-get install --yes git curl unzip",
      ]);

    const rtx = worker
      .withExec([
        "sh",
        "-c",
        ["apt-get update", "apt-get install -y xz-utils"].join(" && "),
      ])
      .withExec(
        `curl -L https://github.com/jdx/rtx/releases/download/v2023.10.1/rtx-v2023.10.1-linux-${arch}.tar.xz -o rtx.tar.xz`.split(
          /\s+/
        )
      )
      .withExec("tar xvf rtx.tar.xz".split(/\s+/));

    const base = worker.withFile("/usr/local/bin/rtx", rtx.file("rtx/bin/rtx"));

    const baseExcludes = ["tmp", "**/node_modules"];

    const sourceDirectory = client
      .host()
      .directory(".", { exclude: [...baseExcludes] });

    const builder = base
      .withDirectory(".", sourceDirectory)
      .withExec([
        "sh",
        "-c",
        ["rtx install --yes", "rtx cache clear"].join(" && "),
      ]);

    const diff = await base.directory("/").diff(builder.directory("/"));

    await diff.sync();
    // await diff.export("tmp/builder-diff");

    return;

    // use a node:16-slim container
    // mount the source code directory on the host
    // at /src in the container
    // mount the cache volume to persist dependencies
    const source = client
      .container()
      .from("node:16-slim")
      .withDirectory("/src", client.host().directory("."), {
        exclude: ["node_modules/", "ci/"],
      })
      .withMountedCache("/src/node_modules", nodeCache);

    // set the working directory in the container
    // install application dependencies
    const runner = source.withWorkdir("/src").withExec(["npm", "install"]);

    // run application tests
    const test = runner.withExec(["npm", "test", "--", "--watchAll=false"]);

    // first stage
    // build application
    const buildDir = test
      .withExec(["npm", "run", "build"])
      .directory("./build");

    // second stage
    // use an nginx:alpine container
    // copy the build/ directory from the first stage
    // publish the resulting container to a registry
    // await publishNginxImage(client, buildDir);
  },
  { LogOutput: process.stdout }
);

async function publishNginxImage(client, buildDir) {
  const imageRef = await client
    .container()
    .from("nginx:1.23-alpine")
    .withDirectory("/usr/share/nginx/html", buildDir)
    .publish("ttl.sh/hello-dagger-" + Math.floor(Math.random() * 10000000));
  console.log(`Published image to: ${imageRef}`);
}
