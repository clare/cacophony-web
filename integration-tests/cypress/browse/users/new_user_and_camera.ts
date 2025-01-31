/// <reference path="../../support/index.d.ts" />

context("Users can see footage from their cameras", () => {
  const username = "integration";
  const group = "int-test";
  const camera = "int-test";
  it("A new user can create an account, and a group", () => {
    cy.registerNewUserAs(username);

    cy.contains("Create a group").click();
    cy.createGroup(group);

    // create a camera in the group
    cy.apiCreateDevice(camera, group);

    // check that user can see camera
    cy.checkDeviceInGroup(camera, group);
  });

  it("A camera event can be triggered", () => {
    cy.apiSignInAs(username);
    cy.apiEventsAdd(camera, { type: "throttle" });
    // for event-uploader to upload
    cy.wait(3 * 1000);
    cy.apiEventsCheck(username, camera, {}, [
      { EventDetail: { type: "throttle" } },
    ]);
  });

  it("A camera can trigger and upload a new recording", () => {
    cy.apiSignInAs(username);
    cy.uploadRecording(camera, {});
    // for video to be uploaded
    cy.wait(3 * 1000);
    cy.apiCheckDeviceHasRecordings(username, camera, 1);
  });
});
