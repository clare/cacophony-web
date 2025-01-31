// load the global Cypress types
/// <reference types="cypress" />
/// <reference types="../types" />

declare namespace Cypress {
  type ApiThermalRecordingInfo = import("../types").ApiThermalRecordingInfo;
  type Interception = import("cypress/types/net-stubbing").Interception;
  type RecordingId = number;

  interface Chainable {
    /**
     * upload a single recording to for a particular camera using deviceId and user credentials
     * Optionally, save the id against provided recordingName
     */
    uploadRecordingOnBehalfUsingDevice(
      deviceName: string,
      userName: string,
      details: ApiThermalRecordingInfo,
      log?: boolean,
      recordingName?: string
    ): Cypress.Chainable<RecordingId>;

    /**
     * upload a single recording to for a particular camera using devicename and groupname and user credentials
     * Optionally, save the id against provided recordingName
     */
    uploadRecordingOnBehalfUsingGroup(
      deviceName: string,
      groupName: string,
      userName: string,
      details: ApiThermalRecordingInfo,
      log?: boolean,
      recordingName?: string
    ): Cypress.Chainable<RecordingId>;
    /**
     * upload a single recording to for a particular camera
     * Optionally, save the id against provided recordingName
     */
    uploadRecording(
      deviceName: string,
      details: ApiThermalRecordingInfo,
      log?: boolean,
      recordingName?: string
    ): Cypress.Chainable<RecordingId>;

    uploadRecordingThenUserTag(
      deviceName: string,
      details: ApiThermalRecordingInfo,
      tagger: string,
      tag: string
    ): any;

    userTagRecording(
      recordingId: number,
      trackIndex: number,
      tagger: string,
      tag: string
    ): any;

    uploadRecordingsAtTimes(deviceName: string, times: string[]): any;

    // to be run straight after an uploadRecording
    thenUserTagAs(tagger: string, tag: string): any;

    /**
     * Check recording count for device matches expected value
     */
    apiCheckDeviceHasRecordings(
      userName: string,
      deviceName: string,
      count: number
    ): any;
  }
}
